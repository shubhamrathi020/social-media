import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../common/infra.module';
import { RequestUploadDto } from './dto';
import { MAX_BYTES, MediaKind, MediaPurpose, validateUploadRequest } from './media.rules';
import { MediaProcessor } from './media.processor';
import { StorageService } from './storage.service';

export interface MediaView {
  id: string;
  kind: MediaKind;
  status: 'uploading' | 'processing' | 'ready' | 'failed';
  mime: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  url?: string;
  thumbUrl?: string;
  error?: string | null;
}

const COLS = `id, kind, purpose, status, mime, width, height, duration_ms AS "durationMs",
  storage_key AS "storageKey", thumb_key AS "thumbKey", error`;

@Injectable()
export class MediaService {
  constructor(
    @Inject(PG_POOL) private readonly pg: Pool,
    private readonly storage: StorageService,
    private readonly processor: MediaProcessor,
  ) {}

  async requestUpload(ownerId: string, dto: RequestUploadDto) {
    validateUploadRequest(dto.kind, dto.purpose, dto.mime, dto.sizeBytes);

    const ins = await this.pg.query(
      `INSERT INTO media (owner_id, kind, purpose, mime, declared_size_bytes, raw_key)
       VALUES ($1,$2,$3,$4,$5, 'pending') RETURNING id`,
      [ownerId, dto.kind, dto.purpose, dto.mime, dto.sizeBytes],
    );
    const id: string = ins.rows[0].id;
    const rawKey = `u/${ownerId}/${id}/raw`;
    await this.pg.query('UPDATE media SET raw_key = $2 WHERE id = $1', [id, rawKey]);

    const expiresIn = 900;
    return {
      id,
      upload: {
        method: 'PUT' as const,
        url: await this.storage.presignPut(rawKey, dto.mime, expiresIn),
        headers: { 'Content-Type': dto.mime },
        expiresIn,
      },
    };
  }

  /** Called by the client once the PUT finished. Verifies the object, then hands it to the worker. */
  async complete(ownerId: string, id: string): Promise<MediaView> {
    const r = await this.pg.query(`SELECT ${COLS}, raw_key AS "rawKey", declared_size_bytes AS declared
                                     FROM media WHERE id = $1 AND owner_id = $2`, [id, ownerId]);
    const m = r.rows[0];
    if (!m) throw new NotFoundException();
    if (m.status !== 'uploading') throw new ConflictException(`Media is already ${m.status}`);

    const head = await this.storage.head(m.rawKey);
    if (!head) throw new BadRequestException('Upload not found; PUT the file first');
    if (head.size > MAX_BYTES[m.kind as MediaKind] || head.size > Number(m.declared) * 1.01) {
      await this.storage.delete(m.rawKey).catch(() => undefined);
      await this.pg.query(`UPDATE media SET status='failed', error='size mismatch' WHERE id=$1`, [id]);
      throw new BadRequestException('Uploaded file is larger than declared');
    }

    await this.pg.query(
      `UPDATE media SET status = 'processing', size_bytes = $2, updated_at = now() WHERE id = $1`,
      [id, head.size],
    );
    await this.processor.enqueue(id);
    return this.get(ownerId, id);
  }

  async get(ownerId: string, id: string): Promise<MediaView> {
    const r = await this.pg.query(`SELECT ${COLS} FROM media WHERE id = $1 AND owner_id = $2`, [id, ownerId]);
    if (!r.rows[0]) throw new NotFoundException();
    return this.toView(r.rows[0]);
  }

  /**
   * For other modules: asserts that `id` is a ready media object owned by `ownerId` for `purpose`.
   * Throws 400 otherwise, so a user cannot attach someone else's (or unfinished) media.
   */
  async assertUsable(ownerId: string, id: string, purposes: MediaPurpose[]): Promise<void> {
    const r = await this.pg.query(
      `SELECT 1 FROM media WHERE id = $1 AND owner_id = $2 AND status = 'ready' AND purpose = ANY($3)`,
      [id, ownerId, purposes],
    );
    if (r.rowCount === 0) throw new BadRequestException('Media is missing, not ready, or not yours');
  }

  /** Resolves ready media ids to signed delivery URLs. Callers decide who may see what. */
  async resolve(ids: string[]): Promise<Map<string, MediaView>> {
    const out = new Map<string, MediaView>();
    if (ids.length === 0) return out;
    const r = await this.pg.query(`SELECT ${COLS} FROM media WHERE id = ANY($1::uuid[])`, [ids]);
    for (const row of r.rows) out.set(row.id, await this.toView(row));
    return out;
  }

  /** Adds `avatarUrl` (thumbnail) to rows that carry `avatarMediaId`. */
  async withAvatarUrls<T extends { avatarMediaId: string | null }>(rows: T[]): Promise<(T & { avatarUrl: string | null })[]> {
    const ids = [...new Set(rows.map((r) => r.avatarMediaId).filter((x): x is string => !!x))];
    const media = await this.resolve(ids);
    return rows.map((r) => ({
      ...r,
      avatarUrl: r.avatarMediaId ? (media.get(r.avatarMediaId)?.thumbUrl ?? null) : null,
    }));
  }

  /** Deletes objects and rows for media nobody references any more. Callers must have removed references. */
  async purge(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const r = await this.pg.query(
      'SELECT id, raw_key, storage_key, thumb_key FROM media WHERE id = ANY($1::uuid[])',
      [ids],
    );
    for (const row of r.rows) {
      for (const key of [row.raw_key, row.storage_key, row.thumb_key]) {
        if (key && key !== 'pending') await this.storage.delete(key).catch(() => undefined);
      }
    }
    const del = await this.pg.query('DELETE FROM media WHERE id = ANY($1::uuid[])', [ids]);
    return del.rowCount ?? 0;
  }

  private async toView(row: any): Promise<MediaView> {
    const view: MediaView = {
      id: row.id,
      kind: row.kind,
      status: row.status,
      mime: row.mime,
      width: row.width,
      height: row.height,
      durationMs: row.durationMs,
      error: row.status === 'failed' ? row.error : undefined,
    };
    if (row.status === 'ready') {
      if (row.storageKey) view.url = await this.storage.presignGet(row.storageKey);
      if (row.thumbKey) view.thumbUrl = await this.storage.presignGet(row.thumbKey);
    }
    return view;
  }
}
