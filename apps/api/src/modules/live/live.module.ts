import { Module } from '@nestjs/common';
import { FriendsModule } from '../friends/friends.module';
import { LiveController } from './live.controller';
import { LiveGateway } from './live.gateway';
import { LiveService } from './live.service';

@Module({
  imports: [FriendsModule],
  controllers: [LiveController],
  providers: [LiveService, LiveGateway],
})
export class LiveModule {}
