import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../common/infra.module';
import { MediaService } from '../media/media.service';
import { RealtimeService } from '../realtime/realtime.service';

export type EntityType = 'user' | 'post' | 'comment' | 'story';
export type Decision = 'dismiss' | 'remove' | 'suspend_author';

const CONTENT_TABLE: Record<Exclude<EntityType, 'user'>, { table: string; author: string }> = {
  post: { table: 'posts', author: 'author_id' },
  comment: { table: 'comments', author: 'user_id' },
  story: { table: 'stories', author: 'author_id' },
};

@Injectable()
export class ModerationService {
  private readonly log = new Logger(ModerationService.name);

  constructor(
    @Inject(PG_POOL) private readonly pg: Pool,
    private readonly media: MediaService,
    private readonly realtime: RealtimeService,
  ) {}

  /** Number of distinct people who reported an item and are still waiting on a decision. */
  async openReporters(type: EntityType, id: string): Promise<number> {
    const r = await this.pg.query(
      `SELECT count(DISTINCT reporter_id)::int AS n FROM reports
        WHERE entity_type = $1 AND entity_id = $2 AND status IN ('open','reviewing') AND reporter_id IS NOT NULL`,
      [type, id],
    );
    return r.rows[0].n;
  }

  /** Takes content out of circulation until a moderator decides. Idempotent. */
  async hide(type: Exclude<EntityType, 'user'>, id: string, reason: string) {
    const { table } = CONTENT_TABLE[type];
    const r = await this.pg.query(
      `UPDATE ${table} SET hidden_at = now() WHERE id = $1 AND hidden_at IS NULL AND deleted_at IS NULL RETURNING id`,
      [id],
    );
    if (r.rowCount) {
      await this.audit(null, type, id, 'auto_hide', reason);
      this.log.log(`auto-hid ${type} ${id}: ${reason}`);
    }
  }

  /** A report filed by the system itself (for example the image scanner), so it shows up in the queue. */
  async systemReport(type: EntityType, id: string, reason: string, details: string) {
    await this.pg.query(
      `INSERT INTO reports (reporter_id, entity_type, entity_id, reason, details) VALUES (NULL, $1, $2, $3, $4)`,
      [type, id, reason, details],
    );
  }

  // ---- moderator queue ------------------------------------------------------------------------

  /** Reported items grouped per entity, most reported first. */
  async queue(status: 'open' | 'closed', limit = 50) {
    const statuses = status === 'open' ? ['open', 'reviewing'] : ['actioned', 'dismissed'];
    const r = await this.pg.query(
      `SELECT entity_type AS "entityType", entity_id AS "entityId",
              count(*)::int AS "reportCount",
              count(DISTINCT reporter_id)::int AS "reporters",
              bool_or(reporter_id IS NULL) AS "flaggedBySystem",
              array_agg(DISTINCT reason) AS reasons,
              (array_agg(details ORDER BY created_at DESC) FILTER (WHERE details IS NOT NULL))[1:5] AS details,
              min(created_at) AS "firstReportAt", max(created_at) AS "lastReportAt"
         FROM reports WHERE status = ANY($1::text[])
        GROUP BY entity_type, entity_id
        ORDER BY count(*) DESC, max(created_at) DESC
        LIMIT $2`,
      [statuses, Math.min(limit, 200)],
    );
    return Promise.all(r.rows.map(async (row) => ({ ...row, preview: await this.preview(row.entityType, row.entityId) })));
  }

  async decide(moderatorId: string, type: EntityType, id: string, decision: Decision, note?: string) {
    const exists = await this.pg.query(
      `SELECT 1 FROM reports WHERE entity_type = $1 AND entity_id = $2 LIMIT 1`,
      [type, id],
    );
    if (exists.rowCount === 0) throw new NotFoundException('Nothing has been reported for that item');

    if (decision === 'dismiss') {
      if (type !== 'user') {
        await this.pg.query(`UPDATE ${CONTENT_TABLE[type].table} SET hidden_at = NULL WHERE id = $1`, [id]);
      }
      await this.closeReports(type, id, 'dismissed');
      await this.audit(moderatorId, type, id, 'dismiss', note);
      return { ok: true };
    }

    const authorId = await this.authorOf(type, id);
    if (type === 'user' || decision === 'suspend_author') {
      if (!authorId) throw new NotFoundException('Author not found');
      await this.suspend(moderatorId, authorId, note ?? `after report on ${type} ${id}`);
    }
    if (type !== 'user') await this.removeContent(type, id);
    await this.closeReports(type, id, 'actioned');
    await this.audit(moderatorId, type, id, 'remove', note);
    return { ok: true };
  }

  async suspend(moderatorId: string | null, userId: string, note?: string) {
    const r = await this.pg.query(
      `UPDATE users SET suspended_at = now() WHERE id = $1 AND suspended_at IS NULL AND deleted_at IS NULL RETURNING id`,
      [userId],
    );
    if (r.rowCount === 0) {
      const u = await this.pg.query('SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL', [userId]);
      if (u.rowCount === 0) throw new NotFoundException('User not found');
      return; // already suspended
    }
    await this.pg.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
    await this.pg.query('UPDATE devices SET push_token = NULL WHERE user_id = $1', [userId]);
    await this.pg.query(
      `UPDATE live_streams SET status = 'ended', ended_at = now() WHERE host_id = $1 AND status <> 'ended'`,
      [userId],
    );
    this.realtime.emitToUsers([userId], 'account:suspended', {});
    await this.audit(moderatorId, 'user', userId, 'suspend', note);
  }

  async unsuspend(moderatorId: string, userId: string, note?: string) {
    const r = await this.pg.query('UPDATE users SET suspended_at = NULL WHERE id = $1 AND suspended_at IS NOT NULL', [userId]);
    if (r.rowCount === 0) throw new BadRequestException('That account is not suspended');
    await this.audit(moderatorId, 'user', userId, 'unsuspend', note);
  }

  async actions(limit = 100) {
    const r = await this.pg.query(
      `SELECT a.id, a.entity_type AS "entityType", a.entity_id AS "entityId", a.action, a.note,
              a.created_at AS "createdAt",
              CASE WHEN a.moderator_id IS NULL THEN NULL
                   ELSE COALESCE(u.username, u.display_name, 'moderator') END AS moderator
         FROM moderation_actions a LEFT JOIN users u ON u.id = a.moderator_id
        ORDER BY a.created_at DESC LIMIT $1`,
      [Math.min(limit, 500)],
    );
    return r.rows;
  }

  async isAdmin(userId: string) {
    const r = await this.pg.query(
      'SELECT 1 FROM users WHERE id = $1 AND is_admin AND deleted_at IS NULL AND suspended_at IS NULL',
      [userId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  // ---- internals -------------------------------------------------------------------------------

  private async removeContent(type: Exclude<EntityType, 'user'>, id: string) {
    if (type === 'comment') {
      const c = await this.pg.query(
        `UPDATE comments SET deleted_at = now(), body = '' WHERE id = $1 AND deleted_at IS NULL
         RETURNING post_id, parent_id`,
        [id],
      );
      if (c.rows[0]) {
        await this.pg.query('UPDATE posts SET comment_count = GREATEST(comment_count - 1, 0) WHERE id = $1', [
          c.rows[0].post_id,
        ]);
        if (c.rows[0].parent_id) {
          await this.pg.query('UPDATE comments SET reply_count = GREATEST(reply_count - 1, 0) WHERE id = $1', [
            c.rows[0].parent_id,
          ]);
        }
      }
      return;
    }
    await this.pg.query(`UPDATE ${CONTENT_TABLE[type].table} SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [
      id,
    ]);
  }

  private async closeReports(type: EntityType, id: string, status: 'actioned' | 'dismissed') {
    await this.pg.query(
      `UPDATE reports SET status = $3 WHERE entity_type = $1 AND entity_id = $2 AND status IN ('open','reviewing')`,
      [type, id, status],
    );
  }

  private async authorOf(type: EntityType, id: string): Promise<string | null> {
    if (type === 'user') return id;
    const { table, author } = CONTENT_TABLE[type];
    const r = await this.pg.query(`SELECT ${author} AS a FROM ${table} WHERE id = $1`, [id]);
    return r.rows[0]?.a ?? null;
  }

  private async audit(moderatorId: string | null, type: EntityType, id: string, action: string, note?: string) {
    await this.pg.query(
      `INSERT INTO moderation_actions (moderator_id, entity_type, entity_id, action, note) VALUES ($1,$2,$3,$4,$5)`,
      [moderatorId, type, id, action, note?.slice(0, 1000) ?? null],
    );
  }

  /** What a moderator needs to see to decide, including content that is hidden or already removed. */
  private async preview(type: EntityType, id: string) {
    const author = async (userId: string | null) => {
      if (!userId) return null;
      const u = await this.pg.query(
        `SELECT id, username, display_name AS "displayName", suspended_at AS "suspendedAt", deleted_at AS "deletedAt"
           FROM users WHERE id = $1`,
        [userId],
      );
      return u.rows[0] ?? null;
    };
    if (type === 'user') {
      const u = await this.pg.query(
        `SELECT id, username, display_name AS "displayName", bio, avatar_media_id AS "avatarMediaId",
                suspended_at AS "suspendedAt", deleted_at AS "deletedAt" FROM users WHERE id = $1`,
        [id],
      );
      if (!u.rows[0]) return null;
      const [withAvatar] = await this.media.withAvatarUrls(u.rows);
      return withAvatar;
    }
    if (type === 'post') {
      const p = await this.pg.query(
        `SELECT p.caption, p.author_id, p.hidden_at AS "hiddenAt", p.deleted_at AS "deletedAt",
                array_agg(s.media_id ORDER BY s.position) FILTER (WHERE s.media_id IS NOT NULL) AS media
           FROM posts p LEFT JOIN post_slides s ON s.post_id = p.id WHERE p.id = $1 GROUP BY p.id`,
        [id],
      );
      if (!p.rows[0]) return null;
      const m = await this.media.resolve(p.rows[0].media ?? []);
      return {
        caption: p.rows[0].caption,
        hiddenAt: p.rows[0].hiddenAt,
        deletedAt: p.rows[0].deletedAt,
        author: await author(p.rows[0].author_id),
        media: (p.rows[0].media ?? []).map((mid: string) => {
          const v = m.get(mid);
          return v ? { kind: v.kind, thumbUrl: v.thumbUrl, url: v.url } : null;
        }),
      };
    }
    if (type === 'comment') {
      const c = await this.pg.query(
        `SELECT body, user_id, post_id AS "postId", hidden_at AS "hiddenAt", deleted_at AS "deletedAt"
           FROM comments WHERE id = $1`,
        [id],
      );
      if (!c.rows[0]) return null;
      const { user_id, ...rest } = c.rows[0];
      return { ...rest, author: await author(user_id) };
    }
    const s = await this.pg.query(
      `SELECT text, media_id, author_id, kind, hidden_at AS "hiddenAt", deleted_at AS "deletedAt",
              expires_at AS "expiresAt" FROM stories WHERE id = $1`,
      [id],
    );
    if (!s.rows[0]) return null;
    const m = s.rows[0].media_id ? (await this.media.resolve([s.rows[0].media_id])).get(s.rows[0].media_id) : null;
    return {
      kind: s.rows[0].kind,
      text: s.rows[0].text,
      hiddenAt: s.rows[0].hiddenAt,
      deletedAt: s.rows[0].deletedAt,
      expiresAt: s.rows[0].expiresAt,
      author: await author(s.rows[0].author_id),
      media: m ? { kind: m.kind, thumbUrl: m.thumbUrl, url: m.url } : null,
    };
  }
}
