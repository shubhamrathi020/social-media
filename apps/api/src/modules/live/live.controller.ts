import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { AuthUser, CurrentUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { LiveService } from './live.service';

class CreateLiveDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  title?: string;

  @IsOptional()
  @IsIn(['friends', 'close_friends'])
  audience?: 'friends' | 'close_friends';
}

const uuid = new ParseUUIDPipe();

@Controller('live')
export class LiveController {
  constructor(private readonly live: LiveService) {}

  /** Called by the LiveKit server, authenticated by its signature rather than a user token. */
  @Post('webhook')
  @HttpCode(200)
  async webhook(@Req() req: Request & { rawBody?: Buffer }, @Headers('authorization') auth?: string) {
    await this.live.handleWebhook(req.rawBody?.toString('utf8') ?? '', auth);
    return {};
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateLiveDto) {
    return this.live.create(u.userId, dto.title ?? '', dto.audience ?? 'friends');
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  liveNow(@CurrentUser() u: AuthUser) {
    return this.live.liveNow(u.userId);
  }

  @Post(':id/start')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  start(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.live.start(u.userId, id);
  }

  @Post(':id/end')
  @HttpCode(204)
  @UseGuards(JwtAuthGuard)
  async end(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    await this.live.end(u.userId, id);
  }

  /** Returns the viewer token and connection URL. */
  @Post(':id/join')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  join(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.live.join(u.userId, id);
  }
}
