import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../common/infra.module';
import { FriendsService } from '../friends/friends.service';
import { UpdateProfileDto } from './dto';

const PROFILE_COLS = `id, username, display_name AS "displayName", bio,
  avatar_media_id AS "avatarMediaId", is_private AS "isPrivate", created_at AS "createdAt"`;

@Injectable()
export class UsersService {
  constructor(
    @Inject(PG_POOL) private readonly pg: Pool,
    private readonly friends: FriendsService,
  ) {}

  async getMe(userId: string) {
    const r = await this.pg.query(
      `SELECT ${PROFILE_COLS}, phone FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [userId],
    );
    if (!r.rows[0]) throw new NotFoundException();
    return r.rows[0];
  }

  async getPublic(id: string, requesterId: string) {
    const r = await this.pg.query(
      `SELECT ${PROFILE_COLS} FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    if (!r.rows[0]) throw new NotFoundException();
    if (id === requesterId) return { ...r.rows[0], relationship: 'self' };

    const rel = (await this.friends.relationships(requesterId, [id])).get(id)!;
    // A user who blocked you looks like a user that does not exist.
    if (rel === 'blocked_by') throw new NotFoundException();
    return { ...r.rows[0], relationship: rel };
  }

  async updateMe(userId: string, dto: UpdateProfileDto) {
    const map: Record<string, string> = {
      username: 'username',
      displayName: 'display_name',
      bio: 'bio',
      isPrivate: 'is_private',
    };
    const sets: string[] = [];
    const values: unknown[] = [userId];
    for (const [key, col] of Object.entries(map)) {
      const v = (dto as Record<string, unknown>)[key];
      if (v !== undefined) {
        values.push(v);
        sets.push(`${col} = $${values.length}`);
      }
    }
    if (sets.length === 0) return this.getMe(userId);

    try {
      await this.pg.query(
        `UPDATE users SET ${sets.join(', ')}, updated_at = now()
          WHERE id = $1 AND deleted_at IS NULL`,
        values,
      );
    } catch (e: any) {
      if (e.code === '23505') throw new ConflictException('Username is already taken');
      throw e;
    }
    return this.getMe(userId);
  }

  async search(q: string, requesterId: string, limit = 20) {
    const term = q.trim().toLowerCase();
    if (term.length < 2) return [];
    const r = await this.pg.query(
      `SELECT ${PROFILE_COLS}
         FROM users
        WHERE deleted_at IS NULL AND id <> $2
          AND (username ILIKE $1 || '%' OR display_name ILIKE '%' || $1 || '%')
        ORDER BY (username = $1) DESC, similarity(coalesce(username, ''), $1) DESC
        LIMIT $3`,
      [term, requesterId, Math.min(limit, 50)],
    );
    const rels = await this.friends.relationships(requesterId, r.rows.map((row) => row.id));
    return r.rows
      .map((row) => ({ ...row, relationship: rels.get(row.id)! }))
      .filter((row) => row.relationship !== 'blocked_by');
  }

  /** Soft-deletes the account and revokes every session. Data purge is a scheduled job later. */
  async deleteMe(userId: string) {
    const client = await this.pg.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE users SET deleted_at = now(), username = NULL, display_name = NULL, bio = '',
                avatar_media_id = NULL WHERE id = $1`,
        [userId],
      );
      await client.query(
        'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
        [userId],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }
}
