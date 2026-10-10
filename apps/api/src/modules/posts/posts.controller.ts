import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthUser, CurrentUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CommentsService } from './comments.service';
import { CreateCommentDto, CreatePostDto, ReactDto, UpdatePostDto } from './dto';
import { PostsService } from './posts.service';

const uuid = new ParseUUIDPipe();
const cursorOf = (v?: string) => {
  if (v === undefined) return undefined;
  if (!/^\d{1,18}$/.test(v)) throw new BadRequestException('cursor must be numeric');
  return v;
};
const limitOf = (v?: string) => (v ? Math.max(1, Math.min(Number(v) || 20, 50)) : 20);

@Controller()
@UseGuards(JwtAuthGuard)
export class PostsController {
  constructor(
    private readonly posts: PostsService,
    private readonly comments: CommentsService,
  ) {}

  // posts
  @Post('posts')
  create(@CurrentUser() u: AuthUser, @Body() dto: CreatePostDto) {
    return this.posts.create(u.userId, dto);
  }

  @Get('feed')
  feed(@CurrentUser() u: AuthUser, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.posts.feed(u.userId, cursorOf(cursor), limitOf(limit));
  }

  @Get('users/:userId/posts')
  byAuthor(
    @CurrentUser() u: AuthUser,
    @Param('userId', uuid) userId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.posts.byAuthor(u.userId, userId, cursorOf(cursor), limitOf(limit));
  }

  @Get('posts/:id')
  get(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.posts.get(u.userId, id);
  }

  @Patch('posts/:id')
  update(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body() dto: UpdatePostDto) {
    return this.posts.update(u.userId, id, dto);
  }

  @Delete('posts/:id')
  @HttpCode(204)
  async remove(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    await this.posts.remove(u.userId, id);
  }

  // reactions: value 1 = like, -1 = dislike; DELETE clears it. A user has at most one reaction.
  @Put('posts/:id/reaction')
  react(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body() dto: ReactDto) {
    return this.posts.react(u.userId, id, dto.value);
  }

  @Delete('posts/:id/reaction')
  unreact(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.posts.react(u.userId, id, null);
  }

  // comments
  @Post('posts/:id/comments')
  comment(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body() dto: CreateCommentDto) {
    return this.comments.create(u.userId, id, dto);
  }

  @Get('posts/:id/comments')
  async listComments(
    @CurrentUser() u: AuthUser,
    @Param('id', uuid) id: string,
    @Query('cursor') cursor?: string,
    @Query('parentId') parentId?: string,
    @Query('limit') limit?: string,
  ) {
    if (parentId !== undefined) await uuid.transform(parentId, { type: 'query' });
    return this.comments.list(u.userId, id, { cursor: cursorOf(cursor), parentId, limit: limitOf(limit) });
  }

  @Delete('comments/:id')
  @HttpCode(204)
  async removeComment(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    await this.comments.remove(u.userId, id);
  }

  @Put('comments/:id/reaction')
  reactComment(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string, @Body() dto: ReactDto) {
    return this.comments.react(u.userId, id, dto.value);
  }

  @Delete('comments/:id/reaction')
  unreactComment(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.comments.react(u.userId, id, null);
  }
}
