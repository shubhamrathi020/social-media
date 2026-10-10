import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Pool, PoolClient } from 'pg';
import { Events } from '../../common/events';
import { PG_POOL } from '../../common/infra.module';
import { MediaService, MediaView } from '../media/media.service';
import { ModerationService } from '../moderation/moderation.service';
import { scanPolicy } from '../moderation/content-scanner';
import { RealtimeService } from '../realtime/realtime.service';
import { CreatePostDto, UpdatePostDto } from './dto';
import { POST_VISIBLE_TO_VIEWER } from './visibility';

export interface AuthorView {
  id: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface PostView {
  id: string;
  author: AuthorView;
  caption: string;
  audience: 'public' | 'friends' | 'close_friends';
  slides: { position: number; media: MediaView | null }[];
  likeCount: number;
  /** Only the author sees how many dislikes a post got. */
  dislikeCount?: number;
  commentCount: number;
  myReaction: 1 | -1 | null;
  createdAt: string;
  underReview?: boolean;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

const POST_COLS = `p.id, p.seq, p.author_id AS "authorId", p.caption, p.audience,
  p.like_count AS "likeCount", p.dislike_count AS "dislikeCount", p.comment_count AS "commentCount",
  p.created_at AS "createdAt", p.hidden_at AS "hiddenAt"`;

export const AUTHOR_COLS = `u.id, u.username, u.display_name AS "displayName", u.avatar_media_id AS "avatarMediaId"`;

/**
 * $1 viewer, $2 cursor (seq) or null, $3 row limit. Exported so the query plan can be inspected in tests.
 *
 * The authors are the viewer plus their friends, so relationship checks (blocked? friends? on the author's
 * close-friends list?) are evaluated once per author instead of once per post. A post is then visible when
 * it is the viewer's own, public/friends, or close_friends and the viewer is on that author's list.
 * This mirrors POST_VISIBLE_TO_VIEWER for the friends-only case; keep the two in step.
 */
export const FEED_SQL = `
  WITH friend_ids AS (
    SELECT user_b AS id FROM friendships WHERE user_a = $1
    UNION ALL SELECT user_a FROM friendships WHERE user_b = $1
  ),
  authors AS (
    SELECT $1::uuid AS id, true AS is_me, false AS on_close_list
    UNION ALL
    SELECT f.id, false,
           EXISTS (SELECT 1 FROM close_friends cf WHERE cf.owner_id = f.id AND cf.friend_id = $1)
      FROM friend_ids f
     WHERE NOT EXISTS (SELECT 1 FROM blocks b
                        WHERE (b.blocker_id = $1 AND b.blocked_id = f.id)
                           OR (b.blocker_id = f.id AND b.blocked_id = $1))
  )
  SELECT ${POST_COLS}
    FROM authors a
   CROSS JOIN LATERAL (
          SELECT * FROM posts p
           WHERE p.author_id = a.id AND p.deleted_at IS NULL
             AND ($2::bigint IS NULL OR p.seq < $2)
             AND (a.is_me OR p.hidden_at IS NULL)
             AND (a.is_me OR p.audience IN ('public', 'friends')
                  OR (p.audience = 'close_friends' AND a.on_close_list))
           ORDER BY p.seq DESC LIMIT $3
        ) p
   ORDER BY p.seq DESC LIMIT $3`;

/** Applies a reaction change under a per-(entity,user) advisory lock and returns count deltas. */
export async function applyReaction(
  c: PoolClient,
  table: 'post_reactions' | 'comment_reactions',
  idCol: 'post_id' | 'comment_id',
  entityId: string,
  userId: string,
  value: 1 | -1 | null,
) {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${table}:${entityId}:${userId}`]);
  const prevRes = await c.query(`SELECT value FROM ${table} WHERE ${idCol} = $1 AND user_id = $2`, [
    entityId,
    userId,
  ]);
  const prev: 1 | -1 | null = prevRes.rows[0]?.value ?? null;
  if (prev === value) return { likeDelta: 0, dislikeDelta: 0 };

  if (value === null) {
    await c.query(`DELETE FROM ${table} WHERE ${idCol} = $1 AND user_id = $2`, [entityId, userId]);
  } else {
    await c.query(
      `INSERT INTO ${table} (${idCol}, user_id, value) VALUES ($1, $2, $3)
       ON CONFLICT (${idCol}, user_id) DO UPDATE SET value = EXCLUDED.value`,
      [entityId, userId, value],
    );
  }
  return {
    likeDelta: (value === 1 ? 1 : 0) - (prev === 1 ? 1 : 0),
    dislikeDelta: (value === -1 ? 1 : 0) - (prev === -1 ? 1 : 0),
  };
}

@Injectable()
export class PostsService {
  constructor(
    @Inject(PG_POOL) private readonly pg: Pool,
    private readonly media: MediaService,
    private readonly realtime: RealtimeService,
    private readonly events: EventEmitter2,
    private readonly moderation: ModerationService,
  ) {}

  // ---- create / read -------------------------------------------------------------------------

  async create(me: string, dto: CreatePostDto): Promise<PostView> {
    for (const id of dto.mediaIds) await this.media.assertUsable(me, id, ['post']);

    const client = await this.pg.connect();
    try {
      await client.query('BEGIN');
      const p = await client.query(
        'INSERT INTO posts (author_id, caption, audience) VALUES ($1, $2, $3) RETURNING id',
        [me, (dto.caption ?? '').trim(), dto.audience ?? 'friends'],
      );
      const id: string = p.rows[0].id;
      await client.query(
        `INSERT INTO post_slides (post_id, position, media_id)
         SELECT $1, t.ord, t.mid FROM unnest($2::uuid[]) WITH ORDINALITY AS t(mid, ord)`,
        [id, dto.mediaIds],
      );
      await client.query('COMMIT');
      await this.holdIfFlagged(id, dto.mediaIds);
      return this.get(me, id);
    } catch (e: any) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (e.code === '23505') throw new ConflictException('A media item is already used by another post');
      throw e;
    } finally {
      client.release();
    }
  }

  /** Posts whose images the scanner found borderline are hidden and queued for a moderator. */
  private async holdIfFlagged(postId: string, mediaIds: string[]) {
    const r = await this.pg.query('SELECT max(nsfw_score) AS s FROM media WHERE id = ANY($1::uuid[])', [mediaIds]);
    const score: number | null = r.rows[0]?.s ?? null;
    if (score !== null && score >= scanPolicy().review) {
      await this.moderation.hide('post', postId, `image scan score ${score.toFixed(2)}`);
      await this.moderation.systemReport('post', postId, 'nudity', `automatic image scan (score ${score.toFixed(2)})`);
    }
  }

  async get(viewer: string, id: string): Promise<PostView> {
    const r = await this.pg.query(
      `SELECT ${POST_COLS} FROM posts p
        WHERE p.id = $2 AND p.deleted_at IS NULL AND ${POST_VISIBLE_TO_VIEWER}`,
      [viewer, id],
    );
    if (!r.rows[0]) throw new NotFoundException('Post not found');
    return (await this.hydrate(viewer, r.rows))[0];
  }

  /** 404 unless the viewer may see the post. Also guards comments and reactions. */
  async assertVisible(viewer: string, postId: string): Promise<{ authorId: string }> {
    const r = await this.pg.query(
      `SELECT p.author_id AS "authorId" FROM posts p
        WHERE p.id = $2 AND p.deleted_at IS NULL AND ${POST_VISIBLE_TO_VIEWER}`,
      [viewer, postId],
    );
    if (!r.rows[0]) throw new NotFoundException('Post not found');
    return r.rows[0];
  }

  /**
   * Posts from me and my friends, newest first, filtered by each post's audience.
   *
   * Each author is probed through the (author_id, seq DESC) index for at most `limit` visible posts and the
   * results are merged. Cost therefore depends on how many friends you have, not on how big the posts table
   * is; scanning the global timeline and discarding strangers' posts would get slower as the app grows.
   */
  async feed(viewer: string, cursor?: string, limit = 20): Promise<Page<PostView>> {
    const n = Math.min(limit, 50);
    const r = await this.pg.query(FEED_SQL, [viewer, cursor ?? null, n + 1]);
    return this.page(viewer, r.rows, n);
  }

  async byAuthor(viewer: string, authorId: string, cursor?: string, limit = 20): Promise<Page<PostView>> {
    const n = Math.min(limit, 50);
    const r = await this.pg.query(
      `SELECT ${POST_COLS} FROM posts p
        WHERE p.author_id = $2 AND p.deleted_at IS NULL AND ($3::bigint IS NULL OR p.seq < $3)
          AND ${POST_VISIBLE_TO_VIEWER}
        ORDER BY p.seq DESC LIMIT $4`,
      [viewer, authorId, cursor ?? null, n + 1],
    );
    return this.page(viewer, r.rows, n);
  }

  private async page(viewer: string, rows: any[], n: number): Promise<Page<PostView>> {
    const more = rows.length > n;
    const slice = more ? rows.slice(0, n) : rows;
    return {
      items: await this.hydrate(viewer, slice),
      nextCursor: more ? String(slice[slice.length - 1].seq) : null,
    };
  }

  // ---- edit / delete ---------------------------------------------------------------------------

  async update(me: string, id: string, dto: UpdatePostDto): Promise<PostView> {
    const r = await this.pg.query(
      `UPDATE posts SET caption = COALESCE($3, caption), audience = COALESCE($4, audience), updated_at = now()
        WHERE id = $1 AND author_id = $2 AND deleted_at IS NULL RETURNING id`,
      [id, me, dto.caption?.trim() ?? null, dto.audience ?? null],
    );
    if (r.rowCount === 0) throw await this.notFoundOrForbidden(me, id);
    return this.get(me, id);
  }

  async remove(me: string, id: string) {
    const r = await this.pg.query(
      'UPDATE posts SET deleted_at = now() WHERE id = $1 AND author_id = $2 AND deleted_at IS NULL',
      [id, me],
    );
    if (r.rowCount === 0) throw await this.notFoundOrForbidden(me, id);
  }

  private async notFoundOrForbidden(me: string, id: string) {
    await this.assertVisible(me, id); // throws 404 if the viewer cannot see it at all
    return new ForbiddenException('Only the author can do that');
  }

  // ---- reactions -------------------------------------------------------------------------------

  async react(me: string, postId: string, value: 1 | -1 | null) {
    await this.assertVisible(me, postId);
    const client = await this.pg.connect();
    try {
      await client.query('BEGIN');
      const d = await applyReaction(client, 'post_reactions', 'post_id', postId, me, value);
      const r = await client.query(
        `UPDATE posts SET like_count = like_count + $2, dislike_count = dislike_count + $3
          WHERE id = $1
          RETURNING like_count AS "likeCount", dislike_count AS "dislikeCount", comment_count AS "commentCount",
                    author_id AS "authorId"`,
        [postId, d.likeDelta, d.dislikeDelta],
      );
      await client.query('COMMIT');
      const row = r.rows[0];
      this.broadcastCounters(postId, row.likeCount, row.commentCount);
      if (d.likeDelta > 0 && row.authorId !== me) {
        this.events.emit(Events.PostLiked, { postId, authorId: row.authorId, actorId: me });
      }
      return {
        postId,
        likeCount: row.likeCount as number,
        commentCount: row.commentCount as number,
        ...(row.authorId === me ? { dislikeCount: row.dislikeCount as number } : {}),
        myReaction: value,
      };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  broadcastCounters(postId: string, likeCount: number, commentCount: number) {
    this.realtime.emitToRoom(`post:${postId}`, 'post:counters', { postId, likeCount, commentCount });
  }

  // ---- hydration -------------------------------------------------------------------------------

  async hydrate(viewer: string, rows: any[]): Promise<PostView[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const authorIds = [...new Set(rows.map((r) => r.authorId))];

    const [slides, authors, mine] = await Promise.all([
      this.pg.query(
        'SELECT post_id AS "postId", position, media_id AS "mediaId" FROM post_slides WHERE post_id = ANY($1::uuid[]) ORDER BY position',
        [ids],
      ),
      this.pg.query(`SELECT ${AUTHOR_COLS} FROM users u WHERE u.id = ANY($1::uuid[])`, [authorIds]),
      this.pg.query('SELECT post_id AS "postId", value FROM post_reactions WHERE user_id = $1 AND post_id = ANY($2::uuid[])', [
        viewer,
        ids,
      ]),
    ]);
    const media = await this.media.resolve(slides.rows.map((s) => s.mediaId));
    const authorViews = new Map<string, AuthorView>();
    for (const a of await this.media.withAvatarUrls(authors.rows)) {
      authorViews.set(a.id, {
        id: a.id,
        username: a.username,
        displayName: a.displayName,
        avatarUrl: a.avatarUrl,
      });
    }
    const myReaction = new Map<string, 1 | -1>(mine.rows.map((m) => [m.postId, m.value]));

    return rows.map((r) => ({
      id: r.id,
      author: authorViews.get(r.authorId)!,
      caption: r.caption,
      audience: r.audience,
      slides: slides.rows
        .filter((s) => s.postId === r.id)
        .map((s) => ({ position: s.position, media: media.get(s.mediaId) ?? null })),
      likeCount: r.likeCount,
      ...(r.authorId === viewer ? { dislikeCount: r.dislikeCount } : {}),
      commentCount: r.commentCount,
      myReaction: myReaction.get(r.id) ?? null,
      createdAt: r.createdAt,
      // Only the author ever receives a hidden post, so this tells them it is waiting for a moderator.
      ...(r.authorId === viewer && r.hiddenAt ? { underReview: true } : {}),
    }));
  }
}
