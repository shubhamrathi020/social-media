import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, ValidateNested } from 'class-validator';

const AUDIENCES = ['everyone', 'friends', 'nobody'] as const;

export class PrivacyDto {
  @IsOptional() @IsIn(AUDIENCES) messages?: (typeof AUDIENCES)[number];
  @IsOptional() @IsIn(AUDIENCES) lastSeen?: (typeof AUDIENCES)[number];
  @IsOptional() @IsIn(AUDIENCES) stories?: (typeof AUDIENCES)[number];
}

export class NotificationsDto {
  @IsOptional() @IsBoolean() messages?: boolean;
  @IsOptional() @IsBoolean() friendRequests?: boolean;
  @IsOptional() @IsBoolean() likes?: boolean;
  @IsOptional() @IsBoolean() comments?: boolean;
  @IsOptional() @IsBoolean() live?: boolean;
}

export class MediaPrefsDto {
  @IsOptional() @IsBoolean() dataSaver?: boolean;
  @IsOptional() @IsBoolean() autoplay?: boolean;
}

export class UpdateSettingsDto {
  @IsOptional() @ValidateNested() @Type(() => PrivacyDto) privacy?: PrivacyDto;
  @IsOptional() @ValidateNested() @Type(() => NotificationsDto) notifications?: NotificationsDto;
  @IsOptional() @ValidateNested() @Type(() => MediaPrefsDto) media?: MediaPrefsDto;
  @IsOptional() @IsString() language?: string;
  @IsOptional() @IsIn(['light', 'dark', 'system']) theme?: 'light' | 'dark' | 'system';
}
