import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  Global,
  Header,
  HttpCode,
  Injectable,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import type { Response } from 'express';
import { readFileSync } from 'fs';
import { join } from 'path';
import { AuthUser, CurrentUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ContentScanner, NoopScanner, NsfwJsScanner } from './content-scanner';
import { TestColourScanner } from './test-scanner';
import { ModerationService } from './moderation.service';

/** Must run after JwtAuthGuard. Re-checks the database on every call, so revoking admin rights is immediate. */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly moderation: ModerationService) {}

  async canActivate(ctx: ExecutionContext) {
    const user = ctx.switchToHttp().getRequest().user as AuthUser | undefined;
    if (!user || !(await this.moderation.isAdmin(user.userId))) throw new ForbiddenException('Moderators only');
    return true;
  }
}

class DecisionDto {
  @IsIn(['user', 'post', 'comment', 'story'])
  entityType!: 'user' | 'post' | 'comment' | 'story';

  @IsUUID()
  entityId!: string;

  @IsIn(['dismiss', 'remove', 'suspend_author'])
  decision!: 'dismiss' | 'remove' | 'suspend_author';

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

class NoteDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

const uuid = new ParseUUIDPipe();
const asset = (name: string) => readFileSync(join(__dirname, 'admin-ui', name), 'utf8');

@Controller('admin')
export class ModerationController {
  constructor(private readonly moderation: ModerationService) {}

  // ---- the moderator web page (static; it signs in with the normal phone + code flow) ----

  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  // Report previews show images from the storage host, which is a different origin.
  @Header(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob: http: https:; media-src 'self' http: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
  )
  page(@Res() res: Response) {
    res.send(asset('index.html'));
  }

  @Get('app.js')
  @Header('Content-Type', 'application/javascript; charset=utf-8')
  script(@Res() res: Response) {
    res.send(asset('app.js'));
  }

  // ---- API ----

  @Get('me')
  @UseGuards(JwtAuthGuard, AdminGuard)
  me(@CurrentUser() u: AuthUser) {
    return { userId: u.userId, isAdmin: true };
  }

  @Get('queue')
  @UseGuards(JwtAuthGuard, AdminGuard)
  queue(@Query('status') status = 'open', @Query('limit') limit?: string) {
    return this.moderation.queue(status === 'closed' ? 'closed' : 'open', limit ? Number(limit) || 50 : 50);
  }

  @Post('decisions')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, AdminGuard)
  decide(@CurrentUser() u: AuthUser, @Body() dto: DecisionDto) {
    return this.moderation.decide(u.userId, dto.entityType, dto.entityId, dto.decision, dto.note);
  }

  @Post('users/:id/suspend')
  @HttpCode(204)
  @UseGuards(JwtAuthGuard, AdminGuard)
  async suspend(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body() dto: NoteDto) {
    if (id === u.userId) throw new ForbiddenException('You cannot suspend yourself');
    await this.moderation.suspend(u.userId, id, dto.note);
  }

  @Post('users/:id/unsuspend')
  @HttpCode(204)
  @UseGuards(JwtAuthGuard, AdminGuard)
  async unsuspend(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body() dto: NoteDto) {
    await this.moderation.unsuspend(u.userId, id, dto.note);
  }

  @Get('actions')
  @UseGuards(JwtAuthGuard, AdminGuard)
  actions() {
    return this.moderation.actions();
  }
}

@Global()
@Module({
  controllers: [ModerationController],
  providers: [
    ModerationService,
    AdminGuard,
    {
      provide: ContentScanner,
      // CONTENT_SCAN=off disables scanning; =test-colour is a deterministic stand-in for automated tests only.
      useFactory: () => {
        const mode = process.env.CONTENT_SCAN ?? 'nsfwjs';
        if (mode === 'off') return new NoopScanner();
        if (mode === 'test-colour') {
          if (process.env.NODE_ENV === 'production') throw new Error('CONTENT_SCAN=test-colour is for tests only');
          return new TestColourScanner();
        }
        return new NsfwJsScanner();
      },
    },
  ],
  exports: [ModerationService, ContentScanner],
})
export class ModerationModule {}
