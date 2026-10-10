import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OtpService } from './otp.service';
import { ConsoleOtpSender, OtpSender } from './otp-sender';
import { JwtAuthGuard } from './jwt-auth.guard';
import { createOtpSender } from './sms-senders';

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        secret: cfg.getOrThrow<string>('JWT_ACCESS_SECRET'),
        signOptions: { expiresIn: '15m' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    OtpService,
    JwtAuthGuard,
    { provide: OtpSender, useFactory: () => createOtpSender(process.env, () => new ConsoleOtpSender()) },
  ],
  exports: [JwtModule, JwtAuthGuard],
})
export class AuthModule {}
