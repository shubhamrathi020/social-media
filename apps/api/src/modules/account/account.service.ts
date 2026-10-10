import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../../common/infra.module';
import { MediaService } from '../media/media.service';
import { RealtimeService } from '../realtime/realtime.service';

const EXPORT_MESSAGE_LIMIT = 20_000;

/**
 * Account lifecycle beyond sign-in: deletion (immediate anonymisation, then a hard purge after a retention
 * period) and export of everything we hold about a person.
 */
@Injectable()
export class AccountService {
  private readonly log = new Logger(AccountService.name);

  constructor(
    @Inject(PG_POOL) private readonly pg: Pool,
    private readonly media: MediaService,
    private readonly realtime: RealtimeService,
  ) {}

  // ---- deletion --------------------------------------------------------------------------------

  /**
   * Takes effect immediately for everyone else: the profile is anonymised and the phone number released,
   * the person disappears from friend lists, groups, feeds and comment threads, and every session ends.
   * Messages in direct chats stay visible to the other side as "Deleted account" until the purge.
   */
  async deleteAccount(userId: string) {
    const groups: { conversationId: string; others: string[] }[] = [];
    await this.tx(async (c) => {
      const u = await c.query('SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [userId]);
      if (u.rowCount === 0) throw new NotFoundException();

      await c.query(
        `UPDATE users SET deleted_at = now(), username = NULL, display_name = NULL, bio = '',
                avatar_media_id = NULL, is_private = true, phone = 'deleted:' || id, phone_hmac = NULL
          WHERE id = $1`,
        [userId],
      );
      await c.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
      await c.query('UPDATE devices SET push_token = NULL WHERE user_id = $1', [userId]);

      // Social graph
      await c.query('DELETE FROM friendships WHERE user_a = $1 OR user_b = $1', [userId]);
      await c.query('DELETE FROM friend_requests WHERE from_user = $1 OR to_user = $1', [userId]);
      await c.query('DELETE FROM close_friends WHERE owner_id = $1 OR friend_id = $1', [userId]);
      await c.query('DELETE FROM contact_hashes WHERE user_id = $1', [userId]);
      await c.query('DELETE FROM suggestion_dismissals WHERE user_id = $1 OR dismissed_id = $1', [userId]);
      await c.query('DELETE FROM notifications WHERE actor_id = $1 OR user_id = $1', [userId]);

      // Content they authored disappears now; rows are hard-deleted by the purge.
      await c.query('UPDATE posts SET deleted_at = now() WHERE author_id = $1 AND deleted_at IS NULL', [userId]);
      await c.query('UPDATE stories SET deleted_at = now() WHERE author_id = $1 AND deleted_at IS NULL', [userId]);
      await c.query(
        `UPDATE posts p SET comment_count = GREATEST(p.comment_count - x.n, 0)
           FROM (SELECT post_id, count(*)::int AS n FROM comments
                  WHERE user_id = $1 AND deleted_at IS NULL GROUP BY post_id) x
          WHERE p.id = x.post_id`,
        [userId],
      );
      await c.query(
        `UPDATE comments SET deleted_at = now(), body = '' WHERE user_id = $1 AND deleted_at IS NULL`,
        [userId],
      );
      await c.query(
        `UPDATE posts p SET like_count = GREATEST(p.like_count - x.likes, 0),
                            dislike_count = GREATEST(p.dislike_count - x.dislikes, 0)
           FROM (SELECT post_id, count(*) FILTER (WHERE value = 1)::int AS likes,
                        count(*) FILTER (WHERE value = -1)::int AS dislikes
                   FROM post_reactions WHERE user_id = $1 GROUP BY post_id) x
          WHERE p.id = x.post_id`,
        [userId],
      );
      await c.query('DELETE FROM post_reactions WHERE user_id = $1', [userId]);
      await c.query(
        `UPDATE comments cm SET like_count = GREATEST(cm.like_count - x.likes, 0),
                                dislike_count = GREATEST(cm.dislike_count - x.dislikes, 0)
           FROM (SELECT comment_id, count(*) FILTER (WHERE value = 1)::int AS likes,
                        count(*) FILTER (WHERE value = -1)::int AS dislikes
                   FROM comment_reactions WHERE user_id = $1 GROUP BY comment_id) x
          WHERE cm.id = x.comment_id`,
        [userId],
      );
      await c.query('DELETE FROM comment_reactions WHERE user_id = $1', [userId]);
      await c.query(
        `UPDATE live_streams SET status = 'ended', ended_at = now() WHERE host_id = $1 AND status <> 'ended'`,
        [userId],
      );

      // Leave every group, keeping an admin in each and deleting groups that become empty.
      const g = await c.query(
        `SELECT cm.conversation_id AS id FROM conversation_members cm
           JOIN conversations c2 ON c2.id = cm.conversation_id
          WHERE cm.user_id = $1 AND c2.type = 'group'`,
        [userId],
      );
      for (const { id } of g.rows) {
        await c.query('DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [id, userId]);
        const rest = await c.query(
          'SELECT user_id, role FROM conversation_members WHERE conversation_id = $1 ORDER BY joined_at',
          [id],
        );
        if (rest.rowCount === 0) {
          await c.query('DELETE FROM conversations WHERE id = $1', [id]);
          continue;
        }
        if (!rest.rows.some((m) => m.role === 'admin')) {
          await c.query(
            `UPDATE conversation_members SET role = 'admin' WHERE conversation_id = $1 AND user_id = $2`,
            [id, rest.rows[0].user_id],
          );
        }
        groups.push({ conversationId: id, others: rest.rows.map((m) => m.user_id) });
      }
    });

    for (const g of groups) this.realtime.emitToUsers(g.others, 'conversation:updated', g);
  }

  /** Irreversibly removes the account and everything it owns, including stored media objects. */
  async purge(userId: string) {
    const owned = await this.pg.query('SELECT id FROM media WHERE owner_id = $1', [userId]);
    await this.tx(async (c) => {
      // Rows that reference the person's media must go before the media itself.
      await c.query('DELETE FROM posts WHERE author_id = $1', [userId]);
      await c.query('DELETE FROM stories WHERE author_id = $1', [userId]);
      await c.query(
        `DELETE FROM conversations
          WHERE type = 'direct'
            AND id IN (SELECT conversation_id FROM conversation_members WHERE user_id = $1)`,
        [userId],
      );
    });
    await this.media.purge(owned.rows.map((r) => r.id));
    // Everything else (messages, sessions, devices, reports, receipts, live streams...) cascades.
    await this.pg.query('DELETE FROM users WHERE id = $1', [userId]);
    this.log.log(`purged account ${userId} (${owned.rowCount} media objects)`);
  }

  /** Accounts deleted more than `days` ago. */
  async purgeDue(days: number, limit = 50): Promise<number> {
    const r = await this.pg.query(
      `SELECT id FROM users WHERE deleted_at < now() - make_interval(days => $1) ORDER BY deleted_at LIMIT $2`,
      [days, limit],
    );
    for (const { id } of r.rows) {
      try {
        await this.purge(id);
      } catch (e) {
        this.log.error(`purge of ${id} failed: ${(e as Error).message}`);
      }
    }
    return r.rowCount ?? 0;
  }

  // ---- export ----------------------------------------------------------------------------------

  /** Everything we store about the person, in one JSON document. Media links are valid for an hour. */
  async export(userId: string) {
    const q = async (sql: string, params: unknown[] = [userId]) => (await this.pg.query(sql, params)).rows;

    const [profile] = await q(
      `SELECT id, phone, username, display_name AS "displayName", bio, is_private AS "isPrivate",
              created_at AS "createdAt", last_seen_at AS "lastSeenAt"
         FROM users WHERE id = $1 AND deleted_at IS NULL`,
    );
    if (!profile) throw new NotFoundException();

    const mediaRows = await q(
      `SELECT id FROM media WHERE owner_id = $1 AND status = 'ready' ORDER BY created_at`,
    );
    const media = await this.media.resolve(mediaRows.map((m) => m.id));

    const messages = await q(
      `SELECT m.id::text, m.conversation_id AS "conversationId", m.sender_id AS "senderId", m.type,
              CASE WHEN m.deleted_at IS NULL AND m.enc_version = 0 THEN convert_from(m.payload, 'UTF8') END AS payload,
              m.created_at AS "createdAt"
         FROM messages m
         JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1
        WHERE m.created_at >= cm.joined_at
        ORDER BY m.id DESC LIMIT ${EXPORT_MESSAGE_LIMIT}`,
    );

    return {
      exportedAt: new Date().toISOString(),
      notes: [
        'Media links expire one hour after the export was created.',
        `At most the newest ${EXPORT_MESSAGE_LIMIT} chat messages are included.`,
      ],
      profile,
      settings: (await q('SELECT privacy, notifications, media, language, theme FROM user_settings WHERE user_id = $1'))[0] ?? null,
      sessions: await q(
        `SELECT s.id, d.platform, s.created_at AS "createdAt", s.last_used_at AS "lastUsedAt", s.revoked_at AS "revokedAt"
           FROM sessions s JOIN devices d ON d.id = s.device_id WHERE s.user_id = $1 ORDER BY s.created_at`,
      ),
      friends: await q(
        `SELECT u.id, u.username, u.display_name AS "displayName", f.created_at AS "since"
           FROM friendships f JOIN users u ON u.id = CASE WHEN f.user_a = $1 THEN f.user_b ELSE f.user_a END
          WHERE f.user_a = $1 OR f.user_b = $1`,
      ),
      friendRequests: await q(
        `SELECT id, from_user AS "from", to_user AS "to", status, created_at AS "createdAt"
           FROM friend_requests WHERE from_user = $1 OR to_user = $1`,
      ),
      closeFriends: await q('SELECT friend_id AS "userId", created_at AS "createdAt" FROM close_friends WHERE owner_id = $1'),
      blocked: await q('SELECT blocked_id AS "userId", created_at AS "createdAt" FROM blocks WHERE blocker_id = $1'),
      posts: await q(
        `SELECT p.id, p.caption, p.audience, p.created_at AS "createdAt", p.deleted_at AS "deletedAt",
                array_agg(s.media_id ORDER BY s.position) AS "mediaIds"
           FROM posts p LEFT JOIN post_slides s ON s.post_id = p.id
          WHERE p.author_id = $1 GROUP BY p.id ORDER BY p.created_at`,
      ),
      comments: await q(
        `SELECT id, post_id AS "postId", parent_id AS "parentId", body, created_at AS "createdAt"
           FROM comments WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
      ),
      reactions: await q('SELECT post_id AS "postId", value, created_at AS "createdAt" FROM post_reactions WHERE user_id = $1'),
      stories: await q(
        `SELECT id, kind, text, media_id AS "mediaId", audience, created_at AS "createdAt", expires_at AS "expiresAt"
           FROM stories WHERE author_id = $1 ORDER BY created_at`,
      ),
      conversations: await q(
        `SELECT c.id, c.type, c.title, cm.role, cm.joined_at AS "joinedAt"
           FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id WHERE cm.user_id = $1`,
      ),
      messages: messages.map((m) => ({ ...m, payload: m.payload ? JSON.parse(m.payload) : null })),
      liveStreams: await q(
        `SELECT id, title, audience, started_at AS "startedAt", ended_at AS "endedAt", peak_viewers AS "peakViewers"
           FROM live_streams WHERE host_id = $1`,
      ),
      reportsFiled: await q(
        'SELECT entity_type AS "entityType", entity_id AS "entityId", reason, status, created_at AS "createdAt" FROM reports WHERE reporter_id = $1',
      ),
      media: mediaRows.map((m) => media.get(m.id)),
    };
  }

  private async tx(fn: (c: PoolClient) => Promise<void>) {
    const c = await this.pg.connect();
    try {
      await c.query('BEGIN');
      await fn(c);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }
}
