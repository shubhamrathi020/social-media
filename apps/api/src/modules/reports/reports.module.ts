import { Body, Controller, HttpCode, Inject, Injectable, Module, NotFoundException, Post, UseGuards, BadRequestException } from '@nestjs/common';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { Pool } from 'pg';
import { PG_POOL } from '../../common/infra.module';
import { AuthUser, CurrentUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PostsModule } from '../posts/posts.module';
import { PostsService } from '../posts/posts.service';
import { RateLimit } from '../../common/rate-limit';
import { ModerationService } from '../moderation/moderation.service';

const ENTITIES = ['user', 'post', 'comment', 'story'] as const;
const REASONS = ['spam', 'harassment', 'nudity', 'violence', 'hate', 'misinformation', 'other'] as const;

class CreateReportDto {
  @IsIn(ENTITIES)
  entityType!: (typeof ENTITIES)[number];

  @IsUUID()
  entityId!: string;

  @IsIn(REASONS)
  reason!: (typeof REASONS)[number];

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  details?: string;
}

@Injectable()
export class ReportsService {
  constructor(
    @Inject(PG_POOL) private readonly pg: Pool,
    private readonly posts: PostsService,
    private readonly moderation: ModerationService,
  ) {}

  async create(me: string, dto: CreateReportDto) {
    await this.assertReportable(me, dto.entityType, dto.entityId);
    if (dto.entityType === 'user' && dto.entityId === me) throw new BadRequestException('You cannot report yourself');

    // Reporting the same thing twice is a no-op, not an error: the client may retry.
    const r = await this.pg.query(
      `INSERT INTO reports (reporter_id, entity_type, entity_id, reason, details)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (reporter_id, entity_type, entity_id) DO NOTHING
       RETURNING id`,
      [me, dto.entityType, dto.entityId, dto.reason, dto.details?.trim() || null],
    );
    if (r.rows[0] && dto.entityType !== 'user') {
      const threshold = Number(process.env.AUTO_HIDE_REPORTS ?? 3);
      if ((await this.moderation.openReporters(dto.entityType, dto.entityId)) >= threshold) {
        await this.moderation.hide(dto.entityType, dto.entityId, `${threshold}+ people reported it`);
      }
    }
    return { id: r.rows[0]?.id ?? null, received: true };
  }

  /** Reporters may only report what they can see; this also prevents probing for hidden content. */
  private async assertReportable(me: string, type: string, id: string) {
    if (type === 'post') {
      await this.posts.assertVisible(me, id);
      return;
    }
    if (type === 'comment') {
      const c = await this.pg.query('SELECT post_id FROM comments WHERE id = $1', [id]);
      if (!c.rows[0]) throw new NotFoundException('Not found');
      await this.posts.assertVisible(me, c.rows[0].post_id);
      return;
    }
    const table = type === 'user' ? 'users' : 'stories';
    const r = await this.pg.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id]);
    if (r.rowCount === 0) throw new NotFoundException('Not found');
  }
}

@Controller('reports')
@UseGuards(JwtAuthGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Post()
  @HttpCode(201)
  @RateLimit(20, 86400, 'reports')
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateReportDto) {
    return this.reports.create(u.userId, dto);
  }
}

@Module({
  imports: [PostsModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
