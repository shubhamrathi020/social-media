import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsOptional, IsString, IsUUID, Matches } from 'class-validator';
import { AuthUser, CurrentUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { NotificationsService } from './notifications.service';

class MarkReadDto {
  /** Omit to mark everything as read. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  ids?: string[];
}

class RegisterDeviceDto {
  /** Expo push token, or null to stop receiving pushes on this device. */
  @IsOptional()
  @IsString()
  @Matches(/^(Expo|Exponent)PushToken\[[^\]]+\]$/, { message: 'pushToken must be an Expo push token' })
  pushToken?: string | null;
}

@Controller()
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get('notifications')
  list(@CurrentUser() u: AuthUser, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    if (cursor !== undefined && !/^\d{1,18}$/.test(cursor)) throw new BadRequestException('cursor must be numeric');
    return this.notifications.list(u.userId, cursor, limit ? Number(limit) || 30 : 30);
  }

  @Get('notifications/unread-count')
  unread(@CurrentUser() u: AuthUser) {
    return this.notifications.unreadCount(u.userId);
  }

  @Post('notifications/read')
  @HttpCode(200)
  read(@CurrentUser() u: AuthUser, @Body() dto: MarkReadDto) {
    return this.notifications.markRead(u.userId, dto.ids);
  }

  @Put('devices/me')
  @HttpCode(204)
  async registerDevice(@CurrentUser() u: AuthUser, @Body() dto: RegisterDeviceDto) {
    await this.notifications.registerPushToken(u.sessionId, dto.pushToken ?? null);
  }
}
