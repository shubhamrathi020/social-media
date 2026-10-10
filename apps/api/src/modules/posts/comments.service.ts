import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Pool } from 'pg';
import { Events } from '../../common/events';
import { PG_POOL } from '../../common/infra.module';
import { MediaService } from '../media/media.service';
import { RealtimeService } from '../realtime/realtime.service';
import { CreateCommentDto } from './dto';
import { AUTHOR_COLS, AuthorView, Page, PostsService, applyReaction } from './posts.service';

export interface CommentView {
  id: string;
  postId: string;
  parentId: string | null;
  author: AuthorView;
  body: string;
  deleted: boolean;
  likeCount: number;
  replyCount: number;
  myReaction: 1 | -1 | null;
  createdAt: string;
}

const COMMENT_COLS = `c.id, c.seq, c.post_id AS "postId", c.parent_id AS "parentId", c.user_id AS "userId",
  c.body, c.like_count AS "likeCount", c.reply_count AS "replyCount", c.created_at AS "createdAt",
  c.deleted_at AS "deletedAt"`;

const NOT_BLOCKED = `NOT EXISTS (SELECT 1 FROM blocks b
   WHERE (b.blocker_id = $1 AND b.blocked_id = c.user_id) OR (b.blocker_id = c.user_id AND b.blocked_id = $1))`;

@Injectable()
export class CommentsService {
  constructor(
    @Inject(PG_POOL) private readonly pg: Pool,
    private readonly posts: PostsService,
    private readonly media: MediaService,
    private readonly realtime: RealtimeService,
    private readonly events: EventEmitter2,
  ) {}

  async create(me: string, postId: string, dto: CreateCommentDto): Promise<CommentView> {
    const { authorId: postAuthorId } = await this.posts.assertVisible(me, postId);
    const body = dto.body.trim();
    if (!body) throw new BadRequestException('Comment is empty');

    let parentAuthorId: string | null = null;
    if (dto.parentId) {
      const parent = await this.pg.query(
        'SELECT parent_id, user_id, deleted_at FROM comments WHERE id = $1 AND post_id = $2',
        [dto.parentId, postId],
      );
      if (!parent.rows[0]) throw new BadRequestException('Parent comment not found');
      if (parent.rows[0].parent_id) throw new BadRequestException('Replies can only go one level deep');
      parentAuthorId = parent.rows[0].user_id;
    }

    const client = await this.pg.connect();
    let id: string;
    let counters: { likeCount: number; commentCount: number };
    try {
      await client.query('BEGIN');
      const ins = await client.query(
        'INSERT INTO comments (post_id, user_id, parent_id, body) VALUES ($1,$2,$3,$4) RETURNING id',
        [postId, me, dto.parentId ?? null, body],
      );
      id = ins.rows[0].id;
      if (dto.parentId) {
        await client.query('UPDATE comments SET reply_count = reply_count + 1 WHERE id = $1', [dto.parentId]);
      }
      const p = await client.query(
        `UPDATE posts SET comment_count = comment_count + 1 WHERE id = $1
         RETURNING like_count AS "likeCount", comment_count AS "commentCount"`,
        [postId],
      );
      counters = p.rows[0];
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }

    const view = await this.getView(me, id);
    this.realtime.emitToRoom(`post:${postId}`, 'comment:new', view);
    this.posts.broadcastCounters(postId, counters.likeCount, counters.commentCount);
    this.events.emit(Events.CommentCreated, {
      postId,
      commentId: id,
      postAuthorId,
      actorId: me,
      parentAuthorId,
      preview: body.slice(0, 80),
    });
    return view;
  }

  /** Top-level comments newest first, or replies (when parentId is given) oldest first. */
  async list(viewer: string, postId: string, opts: { cursor?: string; parentId?: string; limit?: number }): Promise<Page<CommentView>> {
    await this.posts.assertVisible(viewer, postId);
    const n = Math.min(opts.limit ?? 20, 50);
    const replies = !!opts.parentId;
    const r = await this.pg.query(
      replies
        ? `SELECT ${COMMENT_COLS} FROM comments c
            WHERE c.post_id = $2 AND c.parent_id = $3 AND ($4::bigint IS NULL OR c.seq > $4)
              AND c.deleted_at IS NULL AND (c.hidden_at IS NULL OR c.user_id = $1) AND ${NOT_BLOCKED}
            ORDER BY c.seq ASC LIMIT $5`
        : `SELECT ${COMMENT_COLS} FROM comments c
            WHERE c.post_id = $2 AND c.parent_id IS NULL AND $3::uuid IS NULL
              AND ($4::bigint IS NULL OR c.seq < $4)
              AND (c.deleted_at IS NULL OR c.reply_count > 0) AND (c.hidden_at IS NULL OR c.user_id = $1)
              AND ${NOT_BLOCKED}
            ORDER BY c.seq DESC LIMIT $5`,
      [viewer, postId, opts.parentId ?? null, opts.cursor ?? null, n + 1],
    );
    const more = r.rows.length > n;
    const rows = more ? r.rows.slice(0, n) : r.rows;
    return {
      items: await this.hydrate(viewer, rows),
      nextCursor: more ? String(rows[rows.length - 1].seq) : null,
    };
  }

  async remove(me: string, commentId: string) {
    const r = await this.pg.query(
      `SELECT c.id, c.post_id AS "postId", c.user_id AS "userId", c.parent_id AS "parentId", p.author_id AS "postAuthor"
         FROM comments c JOIN posts p ON p.id = c.post_id
        WHERE c.id = $1 AND c.deleted_at IS NULL`,
      [commentId],
    );
    const c = r.rows[0];
    if (!c) throw new NotFoundException('Comment not found');
    await this.posts.assertVisible(me, c.postId);
    if (c.userId !== me && c.postAuthor !== me) {
      throw new ForbiddenException('You can only delete your own comments, or comments on your post');
    }

    const client = await this.pg.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE comments SET deleted_at = now(), body = '' WHERE id = $1`, [commentId]);
      if (c.parentId) {
        await client.query('UPDATE comments SET reply_count = GREATEST(reply_count - 1, 0) WHERE id = $1', [c.parentId]);
      }
      const p = await client.query(
        `UPDATE posts SET comment_count = GREATEST(comment_count - 1, 0) WHERE id = $1
         RETURNING like_count AS "likeCount", comment_count AS "commentCount"`,
        [c.postId],
      );
      await client.query('COMMIT');
      this.posts.broadcastCounters(c.postId, p.rows[0].likeCount, p.rows[0].commentCount);
      this.realtime.emitToRoom(`post:${c.postId}`, 'comment:deleted', { postId: c.postId, commentId });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async react(me: string, commentId: string, value: 1 | -1 | null) {
    const r = await this.pg.query('SELECT post_id AS "postId" FROM comments WHERE id = $1 AND deleted_at IS NULL', [
      commentId,
    ]);
    if (!r.rows[0]) throw new NotFoundException('Comment not found');
    await this.posts.assertVisible(me, r.rows[0].postId);

    const client = await this.pg.connect();
    try {
      await client.query('BEGIN');
      const d = await applyReaction(client, 'comment_reactions', 'comment_id', commentId, me, value);
      const u = await client.query(
        `UPDATE comments SET like_count = like_count + $2, dislike_count = dislike_count + $3
          WHERE id = $1 RETURNING like_count AS "likeCount"`,
        [commentId, d.likeDelta, d.dislikeDelta],
      );
      await client.query('COMMIT');
      return { commentId, likeCount: u.rows[0].likeCount as number, myReaction: value };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  private async getView(viewer: string, id: string): Promise<CommentView> {
    const r = await this.pg.query(`SELECT ${COMMENT_COLS} FROM comments c WHERE c.id = $1`, [id]);
    return (await this.hydrate(viewer, r.rows))[0];
  }

  private async hydrate(viewer: string, rows: any[]): Promise<CommentView[]> {
    if (rows.length === 0) return [];
    const [authors, mine] = await Promise.all([
      this.pg.query(`SELECT ${AUTHOR_COLS} FROM users u WHERE u.id = ANY($1::uuid[])`, [
        [...new Set(rows.map((r) => r.userId))],
      ]),
      this.pg.query(
        'SELECT comment_id AS "commentId", value FROM comment_reactions WHERE user_id = $1 AND comment_id = ANY($2::uuid[])',
        [viewer, rows.map((r) => r.id)],
      ),
    ]);
    const byId = new Map<string, AuthorView>();
    for (const a of await this.media.withAvatarUrls(authors.rows)) {
      byId.set(a.id, { id: a.id, username: a.username, displayName: a.displayName, avatarUrl: a.avatarUrl });
    }
    const reactions = new Map<string, 1 | -1>(mine.rows.map((m) => [m.commentId, m.value]));
    return rows.map((r) => ({
      id: r.id,
      postId: r.postId,
      parentId: r.parentId,
      author: byId.get(r.userId)!,
      body: r.deletedAt ? '' : r.body,
      deleted: !!r.deletedAt,
      likeCount: r.likeCount,
      replyCount: r.replyCount,
      myReaction: reactions.get(r.id) ?? null,
      createdAt: r.createdAt,
    }));
  }
}
