import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { PG_POOL, REDIS } from '../../common/infra.module';
import { FriendsService } from '../friends/friends.service';

const TTL_MS = 60_000;

/**
 * Presence is a per-user sorted set of socket ids scored by expiry time. A user is online while at least
 * one unexpired member exists; instances refresh their own sockets, so a crashed instance ages out in 60 s.
 */
@Injectable()
export class PresenceService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(PG_POOL) private readonly pg: Pool,
    private readonly friends: FriendsService,
  ) {}

  private key = (userId: string) => `presence:${userId}`;

  /** Returns true when this connection made the user come online. */
  async connect(userId: string, socketId: string): Promise<boolean> {
    const wasOnline = await this.isOnline(userId);
    await this.redis.zadd(this.key(userId), Date.now() + TTL_MS, socketId);
    return !wasOnline;
  }

  async heartbeat(userId: string, socketId: string) {
    await this.redis.zadd(this.key(userId), 'XX', Date.now() + TTL_MS, socketId);
  }

  /** Returns true when this was the user's last connection. */
  async disconnect(userId: string, socketId: string): Promise<boolean> {
    await this.redis.zrem(this.key(userId), socketId);
    if (await this.isOnline(userId)) return false;
    await this.pg.query('UPDATE users SET last_seen_at = now() WHERE id = $1', [userId]);
    return true;
  }

  async isOnline(userId: string): Promise<boolean> {
    const k = this.key(userId);
    await this.redis.zremrangebyscore(k, '-inf', Date.now());
    return (await this.redis.zcard(k)) > 0;
  }

  /** Friends who should hear about this user's presence, honouring the lastSeen privacy setting. */
  async audience(userId: string): Promise<string[]> {
    const s = await this.pg.query(`SELECT privacy->>'lastSeen' AS v FROM user_settings WHERE user_id = $1`, [userId]);
    const setting = s.rows[0]?.v ?? 'friends';
    if (setting === 'nobody') return [];
    return this.friends.friendIds(userId);
  }

  /** Presence for specific users, filtered by what the requester is allowed to see. */
  async visibleTo(requesterId: string, userIds: string[]) {
    const out: Record<string, { online: boolean; lastSeenAt: string | null }> = {};
    if (userIds.length === 0) return out;
    const r = await this.pg.query(
      `SELECT u.id, u.last_seen_at, COALESCE(s.privacy->>'lastSeen', 'friends') AS setting
         FROM users u LEFT JOIN user_settings s ON s.user_id = u.id
        WHERE u.id = ANY($1::uuid[]) AND u.deleted_at IS NULL`,
      [userIds.slice(0, 100)],
    );
    const rels = await this.friends.relationships(requesterId, r.rows.map((x) => x.id));
    for (const row of r.rows) {
      const allowed =
        row.setting === 'everyone' || (row.setting === 'friends' && rels.get(row.id) === 'friends');
      const blocked = ['blocked', 'blocked_by'].includes(rels.get(row.id) ?? '');
      if (!allowed || blocked) continue;
      out[row.id] = { online: await this.isOnline(row.id), lastSeenAt: row.last_seen_at };
    }
    return out;
  }
}
