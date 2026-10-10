import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { PG_POOL } from '../../common/infra.module';
import { MediaService } from '../media/media.service';

const QUEUE = 'maintenance';

/**
 * Housekeeping that releases storage. Visibility rules already hide expired or deleted content, so this
 * is only about reclaiming rows and objects. It deliberately spans tables owned by several modules.
 * A BullMQ job scheduler makes sure only one instance runs each tick even with several API replicas.
 */
@Injectable()
export class MaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(MaintenanceService.name);
  private queue!: Queue;
  private worker!: Worker;
  private conns: Redis[] = [];

  constructor(
    @Inject(PG_POOL) private readonly pg: Pool,
    private readonly media: MediaService,
    private readonly cfg: ConfigService,
  ) {}

  async onModuleInit() {
    const url = this.cfg.getOrThrow<string>('REDIS_URL');
    const mk = () => {
      const c = new Redis(url, { maxRetriesPerRequest: null });
      this.conns.push(c);
      return c;
    };
    this.queue = new Queue(QUEUE, { connection: mk() });
    this.worker = new Worker(QUEUE, () => this.runOnce(), { connection: mk(), concurrency: 1 });
    this.worker.on('failed', (_job, err) => this.log.warn(`maintenance failed: ${err.message}`));

    const every = Number(this.cfg.get('MAINTENANCE_INTERVAL_MS') ?? 10 * 60 * 1000);
    await this.queue.upsertJobScheduler('purge', { every }, { name: 'purge', opts: { removeOnComplete: 20, removeOnFail: 50 } });
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.queue?.close();
    this.conns.forEach((c) => c.disconnect());
  }

  async runOnce() {
    const stories = await this.purgeStories();
    const posts = await this.purgePosts();
    const uploads = await this.purgeAbandonedUploads();
    if (stories + posts + uploads > 0) {
      this.log.log(`purged stories=${stories} posts=${posts} abandonedUploads=${uploads}`);
    }
    return { stories, posts, uploads };
  }

  /** Stories and statuses one hour past expiry (or deleted by their author). */
  private async purgeStories() {
    const r = await this.pg.query(
      `DELETE FROM stories
        WHERE id IN (SELECT id FROM stories
                      WHERE expires_at < now() - interval '1 hour' OR deleted_at < now() - interval '1 hour'
                      LIMIT 500)
        RETURNING media_id`,
    );
    const mediaIds = r.rows.map((x) => x.media_id).filter(Boolean);
    await this.media.purge(mediaIds);
    return r.rowCount ?? 0;
  }

  /** Posts deleted by their author more than a week ago. */
  private async purgePosts() {
    const old = await this.pg.query(
      `SELECT p.id, array_agg(s.media_id) FILTER (WHERE s.media_id IS NOT NULL) AS media
         FROM posts p LEFT JOIN post_slides s ON s.post_id = p.id
        WHERE p.deleted_at < now() - interval '7 days'
        GROUP BY p.id LIMIT 200`,
    );
    if (old.rows.length === 0) return 0;
    await this.pg.query('DELETE FROM posts WHERE id = ANY($1::uuid[])', [old.rows.map((x) => x.id)]);
    await this.media.purge(old.rows.flatMap((x) => x.media ?? []));
    return old.rows.length;
  }

  /** Upload tickets that never completed, and uploads the pipeline rejected. */
  private async purgeAbandonedUploads() {
    const r = await this.pg.query(
      `SELECT id FROM media
        WHERE status IN ('uploading', 'failed') AND created_at < now() - interval '24 hours'
        LIMIT 500`,
    );
    return this.media.purge(r.rows.map((x) => x.id));
  }
}
