import { Type } from 'class-transformer';
import { IsIn, IsOptional, IsString, Length, Matches, ValidateNested } from 'class-validator';

const E164 = /^\+[1-9]\d{7,14}$/;

export class RequestOtpDto {
  @Matches(E164, { message: 'phone must be in E.164 format, e.g. +14155550123' })
  phone!: string;
}

export class DeviceDto {
  @IsIn(['ios', 'android', 'web'])
  platform!: 'ios' | 'android' | 'web';

  @IsOptional()
  @IsString()
  pushToken?: string;
}

export class VerifyOtpDto extends RequestOtpDto {
  @Matches(/^\d{6}$/)
  code!: string;

  @ValidateNested()
  @Type(() => DeviceDto)
  device!: DeviceDto;
}

export class RefreshDto {
  @IsString()
  @Length(20, 200)
  refreshToken!: string;
}
