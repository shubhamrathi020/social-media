import { Module } from '@nestjs/common';
import { FriendsModule } from '../friends/friends.module';
import { ChatController } from './chat.controller';
import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';
import { GroupsService } from './groups.service';

@Module({
  imports: [FriendsModule],
  controllers: [ChatController],
  providers: [ChatService, GroupsService, ChatGateway],
  exports: [ChatService],
})
export class ChatModule {}
