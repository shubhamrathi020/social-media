import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { RateLimit } from '../../common/rate-limit';
import { AuthService } from './auth.service';
import { OtpService } from './otp.service';
import { OtpSender } from './otp-sender';
import { RefreshDto, RequestOtpDto, VerifyOtpDto } from './dto';
import { AuthUser, CurrentUser, JwtAuthGuard } from './jwt-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly otp: OtpService,
    private readonly sender: OtpSender,
  ) {}

  @Post('otp/request')
  @HttpCode(204)
  @RateLimit(60, 60, 'otp-request')
  async request(@Body() dto: RequestOtpDto) {
    const code = await this.otp.issue(dto.phone);
    await this.sender.send(dto.phone, code);
  }

  @Post('otp/verify')
  @HttpCode(200)
  @RateLimit(60, 60, 'otp-verify')
  async verify(@Body() dto: VerifyOtpDto) {
    await this.otp.verify(dto.phone, dto.code);
    return this.auth.loginWithPhone(dto.phone, dto.device);
  }

  @Post('refresh')
  @HttpCode(200)
  @RateLimit(60, 60, 'refresh')
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(JwtAuthGuard)
  async logout(@CurrentUser() u: AuthUser) {
    await this.auth.revokeSession(u.userId, u.sessionId);
  }

  @Get('sessions')
  @UseGuards(JwtAuthGuard)
  sessions(@CurrentUser() u: AuthUser) {
    return this.auth.listSessions(u.userId, u.sessionId);
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  @UseGuards(JwtAuthGuard)
  async revoke(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.auth.revokeSession(u.userId, id);
  }
}
