import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { InfraModule } from './common/infra.module';
import { AuthModule } from './modules/auth/auth.module';
import { ChatModule } from './modules/chat/chat.module';
import { FriendsModule } from './modules/friends/friends.module';
import { MediaModule } from './modules/media/media.module';
import { HealthModule } from './modules/health/health.module';
import { MaintenanceModule } from './modules/maintenance/maintenance.module';
import { PostsModule } from './modules/posts/posts.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { SettingsModule } from './modules/settings/settings.module';
import { StoriesModule } from './modules/stories/stories.module';
import { UsersModule } from './modules/users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'] }),
    InfraModule,
    AuthModule,
    MediaModule,
    HealthModule,
    FriendsModule,
    RealtimeModule,
    ChatModule,
    PostsModule,
    StoriesModule,
    MaintenanceModule,
    UsersModule,
    SettingsModule,
  ],
})
export class AppModule {}
