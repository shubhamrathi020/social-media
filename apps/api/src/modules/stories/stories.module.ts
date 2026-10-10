import { Module } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module';
import { FriendsModule } from '../friends/friends.module';
import { StoriesController } from './stories.controller';
import { StoriesService } from './stories.service';

@Module({
  imports: [FriendsModule, ChatModule],
  controllers: [StoriesController],
  providers: [StoriesService],
})
export class StoriesModule {}
