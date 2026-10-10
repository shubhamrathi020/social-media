import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'crypto';
import { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../../common/infra.module';
import { phoneHmac } from '../../common/phone-hmac';
import { DeviceDto } from './dto';

const REFRESH_TTL_DAYS = 60;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(PG_POOL) private readonly pg: Pool,
    private readonly jwt: JwtService,
  ) {}

  /** Called after the OTP was verified. Creates the user on first login. */
  async loginWithPhone(phone: string, device: DeviceDto) {
    const client = await this.pg.connect();
    try {
      await client.query('BEGIN');
      let userId: string;
      let isNewUser = false;

      const found = await client.query('SELECT id, deleted_at FROM users WHERE phone = $1', [phone]);
      if (found.rowCount === 0) {
        // ON CONFLICT covers two first-logins for the same phone racing each other.
        const ins = await client.query(
          `INSERT INTO users (phone, phone_hmac) VALUES ($1, $2)
           ON CONFLICT (phone) DO UPDATE SET phone = EXCLUDED.phone
           RETURNING id, (xmax = 0) AS inserted`,
          [phone, phoneHmac(phone)],
        );
        userId = ins.rows[0].id;
        isNewUser = ins.rows[0].inserted;
        await client.query(
          'INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING',
          [userId],
        );
      } else {
        if (found.rows[0].deleted_at) throw new UnauthorizedException('Account deleted');
        userId = found.rows[0].id;
      }

      const dev = await client.query(
        'INSERT INTO devices (user_id, platform, push_token) VALUES ($1,$2,$3) RETURNING id',
        [userId, device.platform, device.pushToken ?? null],
      );
      const tokens = await this.createSession(client, userId, dev.rows[0].id);
      await client.query('COMMIT');
      return { ...tokens, userId, isNewUser };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  private async createSession(q: PoolClient, userId: string, deviceId: string): Promise<TokenPair> {
    const secret = randomBytes(32).toString('base64url');
    const res = await q.query(
      `INSERT INTO sessions (user_id, device_id, refresh_token_hash, expires_at)
       VALUES ($1,$2,$3, now() + make_interval(days => $4)) RETURNING id`,
      [userId, deviceId, sha256(secret), REFRESH_TTL_DAYS],
    );
    const sessionId: string = res.rows[0].id;
    return {
      accessToken: await this.jwt.signAsync({ sub: userId, sid: sessionId }),
      refreshToken: `${sessionId}.${secret}`,
    };
  }

  /** Rotates the refresh token. Presenting an already-rotated token revokes the whole session. */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const [sessionId, secret] = refreshToken.split('.');
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!sessionId || !secret || !uuid.test(sessionId)) throw new UnauthorizedException();

    const client = await this.pg.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query(
        `SELECT id, user_id, refresh_token_hash, prev_refresh_token_hash, expires_at, revoked_at
           FROM sessions WHERE id = $1 FOR UPDATE`,
        [sessionId],
      );
      const s = r.rows[0];
      if (!s || s.revoked_at || new Date(s.expires_at) < new Date()) {
        throw new UnauthorizedException();
      }
      const presented = sha256(secret);
      if (presented === s.prev_refresh_token_hash) {
        await client.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [s.id]);
        await client.query('COMMIT');
        throw new UnauthorizedException('Refresh token reuse detected');
      }
      if (presented !== s.refresh_token_hash) throw new UnauthorizedException();

      const next = randomBytes(32).toString('base64url');
      await client.query(
        `UPDATE sessions SET refresh_token_hash = $2, prev_refresh_token_hash = $3,
                last_used_at = now() WHERE id = $1`,
        [s.id, sha256(next), s.refresh_token_hash],
      );
      await client.query('COMMIT');
      return {
        accessToken: await this.jwt.signAsync({ sub: s.user_id, sid: s.id }),
        refreshToken: `${s.id}.${next}`,
      };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined); // no-op if already committed
      throw e;
    } finally {
      client.release();
    }
  }

  async revokeSession(userId: string, sessionId: string) {
    const r = await this.pg.query(
      `UPDATE sessions SET revoked_at = now()
        WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING device_id`,
      [sessionId, userId],
    );
    // A logged-out device must stop receiving this account's pushes.
    if (r.rows[0]) await this.pg.query('UPDATE devices SET push_token = NULL WHERE id = $1', [r.rows[0].device_id]);
  }

  async listSessions(userId: string, currentSessionId: string) {
    const r = await this.pg.query(
      `SELECT s.id, d.platform, s.created_at AS "createdAt", s.last_used_at AS "lastUsedAt"
         FROM sessions s JOIN devices d ON d.id = s.device_id
        WHERE s.user_id = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
        ORDER BY s.last_used_at DESC`,
      [userId],
    );
    return r.rows.map((row) => ({ ...row, current: row.id === currentSessionId }));
  }
}
