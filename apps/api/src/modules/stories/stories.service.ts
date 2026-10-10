import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../common/infra.module';
import { ChatService } from '../chat/chat.service';
import { FriendsService } from '../friends/friends.service';
import { MediaService, MediaView } from '../media/media.service';
import { scanPolicy } from '../moderation/content-scanner';
import { ModerationService } from '../moderation/moderation.service';
import { RealtimeService } from '../realtime/realtime.service';

export type StoryKind = 'story' | 'status';

export interface StoryItem {
  id: string;
  kind: StoryKind;
  media: MediaView | null;
  text: string | null;
  background: string | null;
  audience: 'friends' | 'close_friends';
  createdAt: string;
  expiresAt: string;
  seen: boolean;
  /** Only present on your own items. */
  viewCount?: number;
}

export interface StoryGroup {
  author: { id: string; username: string | null; displayName: string | null; avatarUrl: string | null };
  hasUnseen: boolean;
  isMe: boolean;
  items: StoryItem[];
}

/**
 * Can viewer $1 see story `s`?
 * Author always. Otherwise: no block, the author's privacy.stories setting allows the viewer,
 * and a close_friends item additionally needs the author's close-friends list.
 */
const VISIBLE = `(
  s.deleted_at IS NULL AND s.expires_at > now() AND (
    s.author_id = $1
    OR (
      s.hidden_at IS NULL AND
      NOT EXISTS (SELECT 1 FROM blocks b
                   WHERE (b.blocker_id = $1 AND b.blocked_id = s.author_id)
                      OR (b.blocker_id = s.author_id AND b.blocked_id = $1))
      AND COALESCE((SELECT us.privacy->>'stories' FROM user_settings us WHERE us.user_id = s.author_id), 'friends') <> 'nobody'
      AND (
        EXISTS (SELECT 1 FROM friendships f
                 WHERE f.user_a = LEAST($1::uuid, s.author_id) AND f.user_b = GREATEST($1::uuid, s.author_id))
        OR (
          s.audience = 'friends'
          AND COALESCE((SELECT us.privacy->>'stories' FROM user_settings us WHERE us.user_id = s.author_id), 'friends') = 'everyone'
          AND NOT EXISTS (SELECT 1 FROM users au WHERE au.id = s.author_id AND au.is_private)
        )
      )
      AND (
        s.audience = 'friends'
        OR EXISTS (SELECT 1 FROM close_friends cf WHERE cf.owner_id = s.author_id AND cf.friend_id = $1)
      )
    )
  )
)`;

const COLS = `s.id, s.kind, s.media_id AS "mediaId", s.text, s.background, s.audience,
  s.created_at AS "createdAt", s.expires_at AS "expiresAt", s.author_id AS "authorId"`;

@Injectable()
export class StoriesService {
  constructor(
    @Inject(PG_POOL) private readonly pg: Pool,
    private readonly media: MediaService,
    private readonly friends: FriendsService,
    private readonly chat: ChatService,
    private readonly realtime: RealtimeService,
    private readonly moderation: ModerationService,
  ) {}

  async create(
    me: string,
    kind: StoryKind,
    input: { mediaId?: string; text?: string; background?: string; audience?: 'friends' | 'close_friends' },
  ): Promise<StoryItem> {
    const text = input.text?.trim() || null;
    if (!input.mediaId && !text) throw new BadRequestException('Add media or text');
    if (kind === 'story' && !input.mediaId) throw new BadRequestException('A story needs an image or video');
    if (input.mediaId) await this.media.assertUsable(me, input.mediaId, [kind]);

    let id: string;
    try {
      const r = await this.pg.query(
        `INSERT INTO stories (author_id, kind, media_id, text, background, audience)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [me, kind, input.mediaId ?? null, text, input.background ?? null, input.audience ?? 'friends'],
      );
      id = r.rows[0].id;
    } catch (e: any) {
      if (e.code === '23505') throw new ConflictException('Media is already used');
      throw e;
    }

    if (input.mediaId) {
      const r = await this.pg.query('SELECT nsfw_score AS s FROM media WHERE id = $1', [input.mediaId]);
      const score: number | null = r.rows[0]?.s ?? null;
      if (score !== null && score >= scanPolicy().review) {
        await this.moderation.hide('story', id, `image scan score ${score.toFixed(2)}`);
        await this.moderation.systemReport('story', id, 'nudity', `automatic image scan (score ${score.toFixed(2)})`);
      }
    }
    const [item] = await this.items(me, [{ id }]);
    void this.notifyAudience(me, id, kind, input.audience ?? 'friends');
    return item;
  }

  /** Active items grouped by author: me first, then groups with unseen items, then the rest. */
  async feed(viewer: string, kind: StoryKind): Promise<StoryGroup[]> {
    const r = await this.pg.query(
      `SELECT ${COLS}, s.seq FROM stories s
        WHERE s.kind = $2 AND ${VISIBLE}
          AND (s.author_id = $1 OR EXISTS (
                 SELECT 1 FROM friendships f
                  WHERE f.user_a = LEAST($1::uuid, s.author_id) AND f.user_b = GREATEST($1::uuid, s.author_id))
               OR COALESCE((SELECT us.privacy->>'stories' FROM user_settings us WHERE us.user_id = s.author_id), 'friends') = 'everyone')
        ORDER BY s.seq ASC
        LIMIT 500`,
      [viewer, kind],
    );
    const items = await this.hydrate(viewer, r.rows);

    const authorIds = [...new Set(r.rows.map((x) => x.authorId as string))];
    const authors = authorIds.length
      ? await this.pg.query(
          `SELECT id, username, display_name AS "displayName", avatar_media_id AS "avatarMediaId"
             FROM users WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
          [authorIds],
        )
      : { rows: [] as any[] };
    const withAvatars = await this.media.withAvatarUrls(authors.rows);

    const groups: StoryGroup[] = [];
    for (const a of withAvatars) {
      const mine = items.filter((it) => it.authorId === a.id).map(({ authorId, ...it }) => it);
      groups.push({
        author: { id: a.id, username: a.username, displayName: a.displayName, avatarUrl: a.avatarUrl },
        hasUnseen: a.id !== viewer && mine.some((m) => !m.seen),
        isMe: a.id === viewer,
        items: mine,
      });
    }
    const latest = (g: StoryGroup) => g.items[g.items.length - 1]?.createdAt ?? '';
    return groups.sort(
      (a, b) =>
        Number(b.isMe) - Number(a.isMe) ||
        Number(b.hasUnseen) - Number(a.hasUnseen) ||
        latest(b).localeCompare(latest(a)),
    );
  }

  async markViewed(viewer: string, id: string) {
    const r = await this.pg.query(
      `SELECT s.author_id AS "authorId" FROM stories s WHERE s.id = $2 AND ${VISIBLE}`,
      [viewer, id],
    );
    if (!r.rows[0]) throw new NotFoundException('Story not found');
    if (r.rows[0].authorId === viewer) return; // your own views do not count
    await this.pg.query(
      'INSERT INTO story_views (story_id, viewer_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [id, viewer],
    );
  }

  async viewers(me: string, id: string) {
    const own = await this.pg.query('SELECT 1 FROM stories WHERE id = $1 AND author_id = $2', [id, me]);
    if (own.rowCount === 0) throw new ForbiddenException('Only the author can see viewers');
    const r = await this.pg.query(
      `SELECT u.id, u.username, u.display_name AS "displayName", u.avatar_media_id AS "avatarMediaId",
              v.viewed_at AS "viewedAt"
         FROM story_views v JOIN users u ON u.id = v.viewer_id
        WHERE v.story_id = $1 ORDER BY v.viewed_at DESC LIMIT 500`,
      [id],
    );
    return this.media.withAvatarUrls(r.rows);
  }

  async remove(me: string, id: string) {
    const r = await this.pg.query(
      'UPDATE stories SET deleted_at = now() WHERE id = $1 AND author_id = $2 AND deleted_at IS NULL',
      [id, me],
    );
    if (r.rowCount === 0) throw new NotFoundException('Story not found');
  }

  /** Replies and emoji reactions arrive in the author's DM, like on Instagram. */
  async reply(me: string, id: string, text: string) {
    const body = text.trim();
    if (!body) throw new BadRequestException('Reply is empty');
    const r = await this.pg.query(
      `SELECT s.author_id AS "authorId" FROM stories s WHERE s.id = $2 AND ${VISIBLE}`,
      [me, id],
    );
    if (!r.rows[0]) throw new NotFoundException('Story not found');
    if (r.rows[0].authorId === me) throw new BadRequestException('You cannot reply to your own story');

    const conv = await this.chat.openDirect(me, r.rows[0].authorId);
    const { message } = await this.chat.send(me, {
      conversationId: conv.id,
      clientMsgId: `story-${id}-${Date.now()}`,
      type: 'text',
      payload: { text: body, storyId: id },
    });
    return { conversationId: conv.id, messageId: message.id };
  }

  // ---- internals -------------------------------------------------------------------------------

  private async notifyAudience(me: string, id: string, kind: StoryKind, audience: string) {
    try {
      const ids = audience === 'close_friends' ? await this.friends.closeFriendIds(me) : await this.friends.friendIds(me);
      this.realtime.emitToUsers(ids, kind === 'story' ? 'story:new' : 'status:new', {
        authorId: me,
        itemId: id,
      });
    } catch {
      /* realtime hint only */
    }
  }

  private async items(viewer: string, refs: { id: string }[]): Promise<StoryItem[]> {
    const r = await this.pg.query(`SELECT ${COLS} FROM stories s WHERE s.id = ANY($1::uuid[])`, [
      refs.map((x) => x.id),
    ]);
    return (await this.hydrate(viewer, r.rows)).map(({ authorId, ...it }) => it);
  }

  private async hydrate(viewer: string, rows: any[]): Promise<(StoryItem & { authorId: string })[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const [seen, counts, media] = await Promise.all([
      this.pg.query('SELECT story_id FROM story_views WHERE viewer_id = $1 AND story_id = ANY($2::uuid[])', [viewer, ids]),
      this.pg.query(
        `SELECT story_id, count(*)::int AS n FROM story_views
          WHERE story_id = ANY($1::uuid[]) GROUP BY story_id`,
        [ids],
      ),
      this.media.resolve(rows.map((r) => r.mediaId).filter(Boolean)),
    ]);
    const seenSet = new Set(seen.rows.map((x) => x.story_id));
    const countMap = new Map<string, number>(counts.rows.map((x) => [x.story_id, x.n]));
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      media: r.mediaId ? (media.get(r.mediaId) ?? null) : null,
      text: r.text,
      background: r.background,
      audience: r.audience,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      seen: r.authorId === viewer ? true : seenSet.has(r.id),
      authorId: r.authorId,
      ...(r.authorId === viewer ? { viewCount: countMap.get(r.id) ?? 0 } : {}),
    }));
  }
}
