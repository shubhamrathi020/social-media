import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import Redis from 'ioredis';
import { Pool, PoolClient } from 'pg';
import { PG_POOL, REDIS } from '../../common/infra.module';

export type Relationship =
  | 'none'
  | 'friends'
  | 'request_sent'
  | 'request_received'
  | 'blocked'
  | 'blocked_by';

const REQUESTS_PER_DAY = 50;
const MAX_CONTACT_HASHES = 5000;

/** Friendships are stored once with the smaller id first. UUIDs are lower-case hex, so string order matches. */
export const orderPair = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

const PROFILE = `u.id, u.username, u.display_name AS "displayName", u.avatar_media_id AS "avatarMediaId"`;

@Injectable()
export class FriendsService {
  constructor(
    @Inject(PG_POOL) private readonly pg: Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  // ---- relationship lookup (also used by the users module) -----------------------------------

  async relationships(me: string, ids: string[]): Promise<Map<string, Relationship>> {
    const out = new Map<string, Relationship>();
    if (ids.length === 0) return out;
    const r = await this.pg.query(
      `SELECT other, rel FROM (
         SELECT blocked_id AS other, 'blocked' AS rel FROM blocks
          WHERE blocker_id = $1 AND blocked_id = ANY($2::uuid[])
         UNION ALL
         SELECT blocker_id, 'blocked_by' FROM blocks
          WHERE blocked_id = $1 AND blocker_id = ANY($2::uuid[])
         UNION ALL
         SELECT user_b, 'friends' FROM friendships WHERE user_a = $1 AND user_b = ANY($2::uuid[])
         UNION ALL
         SELECT user_a, 'friends' FROM friendships WHERE user_b = $1 AND user_a = ANY($2::uuid[])
         UNION ALL
         SELECT to_user, 'request_sent' FROM friend_requests
          WHERE from_user = $1 AND status = 'pending' AND to_user = ANY($2::uuid[])
         UNION ALL
         SELECT from_user, 'request_received' FROM friend_requests
          WHERE to_user = $1 AND status = 'pending' AND from_user = ANY($2::uuid[])
       ) t`,
      [me, ids],
    );
    const rank: Record<string, number> = {
      blocked: 5, blocked_by: 5, friends: 4, request_received: 3, request_sent: 2, none: 0,
    };
    for (const row of r.rows as { other: string; rel: Relationship }[]) {
      const cur = out.get(row.other);
      if (!cur || rank[row.rel] > rank[cur]) out.set(row.other, row.rel);
    }
    for (const id of ids) if (!out.has(id)) out.set(id, 'none');
    return out;
  }

  async areFriends(a: string, b: string): Promise<boolean> {
    const [x, y] = orderPair(a, b);
    const r = await this.pg.query('SELECT 1 FROM friendships WHERE user_a = $1 AND user_b = $2', [x, y]);
    return (r.rowCount ?? 0) > 0;
  }

  // ---- requests --------------------------------------------------------------------------------

  async sendRequest(me: string, toId: string) {
    if (me === toId) throw new BadRequestException('You cannot add yourself');

    const target = await this.pg.query('SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL', [toId]);
    if (target.rowCount === 0) throw new NotFoundException('User not found');

    const rel = (await this.relationships(me, [toId])).get(toId)!;
    if (rel === 'blocked' || rel === 'blocked_by') throw new ForbiddenException('Cannot send request');
    if (rel === 'friends') throw new ConflictException('Already friends');
    if (rel === 'request_sent') throw new ConflictException('Request already sent');

    if (rel === 'request_received') {
      const incoming = await this.pg.query(
        `SELECT id FROM friend_requests WHERE from_user = $1 AND to_user = $2 AND status = 'pending'`,
        [toId, me],
      );
      if (incoming.rows[0]) return this.accept(me, incoming.rows[0].id); // both want it: just befriend
    }

    const key = `friendreq:${me}:${new Date().toISOString().slice(0, 10)}`;
    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, 86400);
    if (n > REQUESTS_PER_DAY) {
      throw new HttpException('Daily friend request limit reached', HttpStatus.TOO_MANY_REQUESTS);
    }

    const r = await this.pg.query(
      `INSERT INTO friend_requests (from_user, to_user) VALUES ($1, $2)
       ON CONFLICT (from_user, to_user)
       DO UPDATE SET status = 'pending', created_at = now(), responded_at = NULL
       RETURNING id, status, created_at AS "createdAt"`,
      [me, toId],
    );
    return { ...r.rows[0], fromUser: me, toUser: toId };
  }

  async accept(me: string, requestId: string) {
    return this.tx(async (c) => {
      const r = await c.query(
        `UPDATE friend_requests SET status = 'accepted', responded_at = now()
          WHERE id = $1 AND to_user = $2 AND status = 'pending'
          RETURNING from_user`,
        [requestId, me],
      );
      if (r.rowCount === 0) throw new NotFoundException('Request not found');
      const [a, b] = orderPair(r.rows[0].from_user, me);
      await c.query(
        'INSERT INTO friendships (user_a, user_b) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [a, b],
      );
      return { friendId: r.rows[0].from_user, status: 'accepted' as const };
    });
  }

  async decline(me: string, requestId: string) {
    const r = await this.pg.query(
      `UPDATE friend_requests SET status = 'declined', responded_at = now()
        WHERE id = $1 AND to_user = $2 AND status = 'pending'`,
      [requestId, me],
    );
    if (r.rowCount === 0) throw new NotFoundException('Request not found');
  }

  async cancel(me: string, requestId: string) {
    const r = await this.pg.query(
      `UPDATE friend_requests SET status = 'cancelled', responded_at = now()
        WHERE id = $1 AND from_user = $2 AND status = 'pending'`,
      [requestId, me],
    );
    if (r.rowCount === 0) throw new NotFoundException('Request not found');
  }

  async listRequests(me: string, direction: 'in' | 'out') {
    const [mine, other] = direction === 'in' ? ['to_user', 'from_user'] : ['from_user', 'to_user'];
    const r = await this.pg.query(
      `SELECT fr.id AS "requestId", fr.created_at AS "createdAt", ${PROFILE}
         FROM friend_requests fr JOIN users u ON u.id = fr.${other}
        WHERE fr.${mine} = $1 AND fr.status = 'pending' AND u.deleted_at IS NULL
        ORDER BY fr.created_at DESC LIMIT 100`,
      [me],
    );
    return r.rows.map(({ requestId, createdAt, ...user }) => ({ id: requestId, createdAt, user }));
  }

  // ---- friends & close friends ----------------------------------------------------------------

  async listFriends(me: string, limit = 50, before?: string) {
    const r = await this.pg.query(
      `SELECT ${PROFILE}, f.created_at AS "friendsSince",
              (cf.friend_id IS NOT NULL) AS "isCloseFriend"
         FROM friendships f
         JOIN users u ON u.id = CASE WHEN f.user_a = $1 THEN f.user_b ELSE f.user_a END
         LEFT JOIN close_friends cf ON cf.owner_id = $1 AND cf.friend_id = u.id
        WHERE (f.user_a = $1 OR f.user_b = $1) AND u.deleted_at IS NULL
          AND ($3::timestamptz IS NULL OR f.created_at < $3)
        ORDER BY f.created_at DESC LIMIT $2`,
      [me, Math.min(limit, 100), before ?? null],
    );
    return r.rows;
  }

  async unfriend(me: string, otherId: string) {
    await this.tx(async (c) => {
      await this.removeRelationship(c, me, otherId);
    });
  }

  private async removeRelationship(c: PoolClient, a: string, b: string) {
    const [x, y] = orderPair(a, b);
    await c.query('DELETE FROM friendships WHERE user_a = $1 AND user_b = $2', [x, y]);
    await c.query(
      `DELETE FROM close_friends
        WHERE (owner_id = $1 AND friend_id = $2) OR (owner_id = $2 AND friend_id = $1)`,
      [a, b],
    );
    await c.query(
      `DELETE FROM friend_requests
        WHERE (from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1)`,
      [a, b],
    );
  }

  async listCloseFriends(me: string) {
    const r = await this.pg.query(
      `SELECT ${PROFILE} FROM close_friends cf JOIN users u ON u.id = cf.friend_id
        WHERE cf.owner_id = $1 AND u.deleted_at IS NULL ORDER BY cf.created_at DESC`,
      [me],
    );
    return r.rows;
  }

  async addCloseFriend(me: string, friendId: string) {
    if (!(await this.areFriends(me, friendId))) {
      throw new BadRequestException('Only friends can be added to close friends');
    }
    await this.pg.query(
      'INSERT INTO close_friends (owner_id, friend_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [me, friendId],
    );
  }

  async removeCloseFriend(me: string, friendId: string) {
    await this.pg.query('DELETE FROM close_friends WHERE owner_id = $1 AND friend_id = $2', [me, friendId]);
  }

  // ---- blocks ----------------------------------------------------------------------------------

  async block(me: string, targetId: string) {
    if (me === targetId) throw new BadRequestException('You cannot block yourself');
    const t = await this.pg.query('SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL', [targetId]);
    if (t.rowCount === 0) throw new NotFoundException('User not found');
    await this.tx(async (c) => {
      await c.query(
        'INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [me, targetId],
      );
      await this.removeRelationship(c, me, targetId);
      await c.query(
        `DELETE FROM suggestion_dismissals
          WHERE (user_id = $1 AND dismissed_id = $2) OR (user_id = $2 AND dismissed_id = $1)`,
        [me, targetId],
      );
    });
  }

  async unblock(me: string, targetId: string) {
    await this.pg.query('DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2', [me, targetId]);
  }

  async listBlocked(me: string) {
    const r = await this.pg.query(
      `SELECT ${PROFILE} FROM blocks b JOIN users u ON u.id = b.blocked_id
        WHERE b.blocker_id = $1 ORDER BY b.created_at DESC`,
      [me],
    );
    return r.rows;
  }

  // ---- contacts & suggestions -----------------------------------------------------------------

  /** Replaces the user's uploaded contact set. Hashes are sha256 hex of E.164 numbers. */
  async syncContacts(me: string, hashes: string[]) {
    const unique = [...new Set(hashes.map((h) => h.toLowerCase()))].slice(0, MAX_CONTACT_HASHES);
    await this.tx(async (c) => {
      await c.query('DELETE FROM contact_hashes WHERE user_id = $1', [me]);
      if (unique.length) {
        await c.query(
          'INSERT INTO contact_hashes (user_id, hash) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING',
          [me, unique],
        );
      }
    });
    const m = await this.pg.query(
      `SELECT count(*)::int AS n FROM contact_hashes c JOIN users u ON u.phone_hash = c.hash
        WHERE c.user_id = $1 AND u.id <> $1 AND u.deleted_at IS NULL`,
      [me],
    );
    return { uploaded: unique.length, matched: m.rows[0].n };
  }

  async deleteContacts(me: string) {
    await this.pg.query('DELETE FROM contact_hashes WHERE user_id = $1', [me]);
  }

  /** People you may know: friends-of-friends ranked by mutual count, plus matched phone contacts. */
  async suggestions(me: string, limit = 20) {
    const r = await this.pg.query(
      `WITH my_friends AS (
         SELECT user_b AS id FROM friendships WHERE user_a = $1
         UNION ALL SELECT user_a FROM friendships WHERE user_b = $1
       ),
       fof AS (
         SELECT f.user_b AS candidate FROM my_friends mf JOIN friendships f ON f.user_a = mf.id
         UNION ALL
         SELECT f.user_a FROM my_friends mf JOIN friendships f ON f.user_b = mf.id
       ),
       cand AS (
         SELECT candidate, count(*)::int AS mutual, false AS is_contact FROM fof GROUP BY candidate
         UNION ALL
         SELECT u.id, 0, true FROM contact_hashes c JOIN users u ON u.phone_hash = c.hash
          WHERE c.user_id = $1
       ),
       agg AS (
         SELECT candidate, sum(mutual)::int AS mutual, bool_or(is_contact) AS is_contact
           FROM cand GROUP BY candidate
       )
       SELECT ${PROFILE}, agg.mutual AS "mutualCount",
              CASE WHEN agg.mutual > 0 THEN 'mutual' ELSE 'contact' END AS reason
         FROM agg JOIN users u ON u.id = agg.candidate
        WHERE u.deleted_at IS NULL AND u.id <> $1
          AND u.id NOT IN (SELECT id FROM my_friends)
          AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
                                                    OR (b.blocked_id = $1 AND b.blocker_id = u.id))
          AND NOT EXISTS (SELECT 1 FROM suggestion_dismissals d WHERE d.user_id = $1 AND d.dismissed_id = u.id)
          AND NOT EXISTS (SELECT 1 FROM friend_requests fr WHERE fr.status = 'pending'
                           AND ((fr.from_user = $1 AND fr.to_user = u.id)
                             OR (fr.to_user = $1 AND fr.from_user = u.id)))
        ORDER BY agg.mutual DESC, agg.is_contact DESC, u.created_at DESC
        LIMIT $2`,
      [me, Math.min(limit, 50)],
    );
    return r.rows;
  }

  async dismissSuggestion(me: string, userId: string) {
    if (me === userId) return;
    await this.pg.query(
      `INSERT INTO suggestion_dismissals (user_id, dismissed_id)
       SELECT $1, id FROM users WHERE id = $2 ON CONFLICT DO NOTHING`,
      [me, userId],
    );
  }

  // ---- helpers ---------------------------------------------------------------------------------

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pg.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }
}
