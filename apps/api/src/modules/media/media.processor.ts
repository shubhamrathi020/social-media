import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import ffprobe from 'ffprobe-static';
import Redis from 'ioredis';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Pool } from 'pg';
import sharp from 'sharp';
import { PG_POOL } from '../../common/infra.module';
import { MAX_VIDEO_SECONDS } from './media.rules';
import { StorageService } from './storage.service';

const QUEUE = 'media-processing';

interface Result {
  storageKey: string;
  thumbKey: string | null;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

class RejectedMedia extends Error {}

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${bin} exited ${code}: ${err.slice(-400)}`)),
    );
  });
}

/** Normalises uploads (strips metadata, bounds size) and creates thumbnails. Runs in-process via BullMQ. */
@Injectable()
export class MediaProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(MediaProcessor.name);
  private queue!: Queue;
  private worker!: Worker;
  private conns: Redis[] = [];

  constructor(
    @Inject(PG_POOL) private readonly pg: Pool,
    private readonly storage: StorageService,
    private readonly cfg: ConfigService,
  ) {}

  onModuleInit() {
    const url = this.cfg.getOrThrow<string>('REDIS_URL');
    const mk = () => {
      const c = new Redis(url, { maxRetriesPerRequest: null });
      this.conns.push(c);
      return c;
    };
    this.queue = new Queue(QUEUE, { connection: mk() });
    this.worker = new Worker(QUEUE, (job) => this.process(job.data.mediaId), {
      connection: mk(),
      concurrency: 2,
    });
    this.worker.on('failed', (job, err) => this.log.warn(`job ${job?.id} failed: ${err.message}`));
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.queue?.close();
    this.conns.forEach((c) => c.disconnect());
  }

  enqueue(mediaId: string) {
    return this.queue.add('process', { mediaId }, { attempts: 2, removeOnComplete: 100, removeOnFail: 500 });
  }

  private async process(mediaId: string) {
    const r = await this.pg.query('SELECT * FROM media WHERE id = $1', [mediaId]);
    const m = r.rows[0];
    if (!m || m.status !== 'processing') return;

    try {
      const raw = await this.storage.getBuffer(m.raw_key);
      let out: Result;
      if (m.kind === 'image') out = await this.image(m, raw);
      else if (m.kind === 'video') out = await this.video(m, raw);
      else out = await this.passthrough(m, raw);

      await this.pg.query(
        `UPDATE media SET status = 'ready', storage_key = $2, thumb_key = $3, mime = $4,
                size_bytes = $5, width = $6, height = $7, duration_ms = $8, updated_at = now()
          WHERE id = $1`,
        [mediaId, out.storageKey, out.thumbKey, out.mime, out.size, out.width, out.height, out.durationMs],
      );
      if (out.storageKey !== m.raw_key) await this.storage.delete(m.raw_key).catch(() => undefined);
    } catch (e) {
      const msg = (e as Error).message;
      await this.pg.query(
        `UPDATE media SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`,
        [mediaId, msg.slice(0, 500)],
      );
      await this.storage.delete(m.raw_key).catch(() => undefined);
      if (!(e instanceof RejectedMedia)) throw e; // genuine failures are retried; rejections are final
    }
  }

  private async image(m: any, raw: Buffer): Promise<Result> {
    let main: { data: Buffer; info: sharp.OutputInfo };
    let thumb: Buffer;
    try {
      // The real content type comes from the bytes, not the client's claim. rotate() applies EXIF
      // orientation; output carries no metadata, so GPS and device info are stripped.
      const meta = await sharp(raw).metadata();
      if (!['jpeg', 'png', 'webp'].includes(meta.format ?? '')) throw new Error('unsupported format');
      const fmt = meta.format as 'jpeg' | 'png' | 'webp';
      main = await sharp(raw)
        .rotate()
        .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
        .toFormat(fmt, fmt === 'jpeg' ? { quality: 85 } : {})
        .toBuffer({ resolveWithObject: true });
      thumb = await sharp(raw).rotate().resize({ width: 400, height: 400, fit: 'inside' }).webp({ quality: 75 }).toBuffer();
    } catch {
      throw new RejectedMedia('File is not a valid image');
    }
    const fmt = main.info.format;
    const mime = `image/${fmt}`;
    const base = `u/${m.owner_id}/${m.id}`;
    await this.storage.putBuffer(`${base}/main.${fmt}`, main.data, mime);
    await this.storage.putBuffer(`${base}/thumb.webp`, thumb, 'image/webp');
    return {
      storageKey: `${base}/main.${fmt}`,
      thumbKey: `${base}/thumb.webp`,
      mime,
      size: main.data.length,
      width: main.info.width,
      height: main.info.height,
      durationMs: null,
    };
  }

  private async video(m: any, raw: Buffer): Promise<Result> {
    const dir = await mkdtemp(join(tmpdir(), 'media-'));
    try {
      const src = join(dir, 'src');
      const dst = join(dir, 'out.mp4');
      const poster = join(dir, 'poster.jpg');
      await writeFile(src, raw);

      let info: { duration: number; width: number; height: number };
      try {
        const probe = JSON.parse(
          await run(ffprobe.path, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', src]),
        );
        const v = probe.streams?.find((s: any) => s.codec_type === 'video');
        if (!v) throw new Error('no video stream');
        info = { duration: Number(probe.format?.duration ?? 0), width: v.width, height: v.height };
      } catch {
        throw new RejectedMedia('File is not a valid video');
      }
      if (info.duration > MAX_VIDEO_SECONDS) {
        throw new RejectedMedia(`Video is longer than ${MAX_VIDEO_SECONDS} seconds`);
      }

      // H.264/AAC MP4, max 1280px wide, moov atom first so playback can start while streaming.
      await run(ffmpegPath as string, [
        '-y', '-i', src,
        '-vf', "scale='min(1280,iw)':-2",
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k',
        '-map_metadata', '-1', '-movflags', '+faststart',
        dst,
      ]);
      await run(ffmpegPath as string, [
        '-y', '-ss', String(Math.min(0.5, info.duration / 2)), '-i', dst,
        '-frames:v', '1', '-vf', 'scale=400:-2', poster,
      ]);

      const out = await readFile(dst);
      const base = `u/${m.owner_id}/${m.id}`;
      await this.storage.putBuffer(`${base}/main.mp4`, out, 'video/mp4');
      await this.storage.putBuffer(`${base}/thumb.jpg`, await readFile(poster), 'image/jpeg');

      // Dimensions come from the encoded file: ffmpeg applied rotation and scaling.
      const probeOut = JSON.parse(
        await run(ffprobe.path, ['-v', 'error', '-print_format', 'json', '-show_streams', dst]),
      );
      const ov = probeOut.streams.find((s: any) => s.codec_type === 'video');
      return {
        storageKey: `${base}/main.mp4`,
        thumbKey: `${base}/thumb.jpg`,
        mime: 'video/mp4',
        size: out.length,
        width: ov.width,
        height: ov.height,
        durationMs: Math.round(info.duration * 1000),
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async passthrough(m: any, raw: Buffer): Promise<Result> {
    return {
      storageKey: m.raw_key,
      thumbKey: null,
      mime: m.mime,
      size: raw.length,
      width: null,
      height: null,
      durationMs: null,
    };
  }
}
