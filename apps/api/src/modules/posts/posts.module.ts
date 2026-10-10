import { Module } from '@nestjs/common';
import { CommentsService } from './comments.service';
import { PostsController } from './posts.controller';
import { PostsGateway } from './posts.gateway';
import { PostsService } from './posts.service';

@Module({
  controllers: [PostsController],
  providers: [PostsService, CommentsService, PostsGateway],
  exports: [PostsService],
})
export class PostsModule {}
