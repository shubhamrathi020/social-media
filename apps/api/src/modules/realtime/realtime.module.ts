import { Global, Module } from '@nestjs/common';
import { FriendsModule } from '../friends/friends.module';
import { PresenceService } from './presence.service';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeService } from './realtime.service';

@Global()
@Module({
  imports: [FriendsModule],
  providers: [RealtimeService, PresenceService, RealtimeGateway],
  exports: [RealtimeService, PresenceService],
})
export class RealtimeModule {}
