import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IsHexColor, IsIn, IsOptional, IsString, IsUUID, Length, MaxLength } from 'class-validator';
import { AuthUser, CurrentUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { StoriesService } from './stories.service';

class CreateStoryDto {
  @IsUUID()
  mediaId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(700)
  text?: string;

  @IsOptional()
  @IsIn(['friends', 'close_friends'])
  audience?: 'friends' | 'close_friends';
}

class CreateStatusDto {
  @IsOptional()
  @IsUUID()
  mediaId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(700)
  text?: string;

  @IsOptional()
  @IsHexColor()
  background?: string;

  @IsOptional()
  @IsIn(['friends', 'close_friends'])
  audience?: 'friends' | 'close_friends';
}

class ReplyDto {
  @IsString()
  @Length(1, 500)
  text!: string;
}

const uuid = new ParseUUIDPipe();

@Controller()
@UseGuards(JwtAuthGuard)
export class StoriesController {
  constructor(private readonly stories: StoriesService) {}

  @Post('stories')
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateStoryDto) {
    return this.stories.create(u.userId, 'story', dto);
  }

  @Get('stories/feed')
  feed(@CurrentUser() u: AuthUser) {
    return this.stories.feed(u.userId, 'story');
  }

  @Post('statuses')
  createStatus(@CurrentUser() u: AuthUser, @Body() dto: CreateStatusDto) {
    return this.stories.create(u.userId, 'status', dto);
  }

  @Get('statuses/feed')
  statusFeed(@CurrentUser() u: AuthUser) {
    return this.stories.feed(u.userId, 'status');
  }

  // Stories and statuses share ids, views and deletion.
  @Post('stories/:id/view')
  @HttpCode(204)
  async view(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    await this.stories.markViewed(u.userId, id);
  }

  @Get('stories/:id/viewers')
  viewers(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.stories.viewers(u.userId, id);
  }

  @Post('stories/:id/reply')
  reply(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body() dto: ReplyDto) {
    return this.stories.reply(u.userId, id, dto.text);
  }

  @Delete('stories/:id')
  @HttpCode(204)
  async remove(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    await this.stories.remove(u.userId, id);
  }
}
