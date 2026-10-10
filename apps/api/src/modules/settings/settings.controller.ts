import { Body, Controller, Get, Inject, Patch, UseGuards } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../common/infra.module';
import { AuthUser, CurrentUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UpdateSettingsDto } from './settings.dto';

const COLS = 'privacy, notifications, media, language, theme';

@Controller('settings')
@UseGuards(JwtAuthGuard)
export class SettingsController {
  constructor(@Inject(PG_POOL) private readonly pg: Pool) {}

  @Get()
  async get(@CurrentUser() u: AuthUser) {
    const r = await this.pg.query(`SELECT ${COLS} FROM user_settings WHERE user_id = $1`, [u.userId]);
    return r.rows[0];
  }

  /** JSON groups are merged key-by-key, so a client may send only the toggle it changed. */
  @Patch()
  async update(@CurrentUser() u: AuthUser, @Body() dto: UpdateSettingsDto) {
    const r = await this.pg.query(
      `UPDATE user_settings SET
         privacy       = privacy       || $2::jsonb,
         notifications = notifications || $3::jsonb,
         media         = media         || $4::jsonb,
         language      = COALESCE($5, language),
         theme         = COALESCE($6, theme),
         updated_at    = now()
       WHERE user_id = $1
       RETURNING ${COLS}`,
      [
        u.userId,
        JSON.stringify(dto.privacy ?? {}),
        JSON.stringify(dto.notifications ?? {}),
        JSON.stringify(dto.media ?? {}),
        dto.language ?? null,
        dto.theme ?? null,
      ],
    );
    return r.rows[0];
  }
}
