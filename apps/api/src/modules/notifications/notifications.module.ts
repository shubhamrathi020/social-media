import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { ExpoPushSender, LogPushSender, PushSender } from './push-sender';

@Module({
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    LogPushSender,
    ExpoPushSender,
    {
      provide: PushSender,
      // PUSH_MODE=expo sends for real; the default outside production only logs.
      inject: [LogPushSender, ExpoPushSender],
      useFactory: (log: LogPushSender, expo: ExpoPushSender) =>
        (process.env.PUSH_MODE ?? (process.env.NODE_ENV === 'production' ? 'expo' : 'log')) === 'expo' ? expo : log,
    },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
