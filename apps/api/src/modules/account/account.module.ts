import { Controller, Delete, Get, Header, HttpCode, Module, UseGuards } from '@nestjs/common';
import { RateLimit } from '../../common/rate-limit';
import { AuthUser, CurrentUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AccountService } from './account.service';

@Controller('users/me')
@UseGuards(JwtAuthGuard)
export class AccountController {
  constructor(private readonly account: AccountService) {}

  /** Download everything stored about you as JSON. */
  @Get('export')
  @RateLimit(5, 86400, 'export')
  @Header('Content-Disposition', 'attachment; filename="my-data.json"')
  export(@CurrentUser() u: AuthUser) {
    return this.account.export(u.userId);
  }

  @Delete()
  @HttpCode(204)
  async remove(@CurrentUser() u: AuthUser) {
    await this.account.deleteAccount(u.userId);
  }
}

@Module({
  controllers: [AccountController],
  providers: [AccountService],
  exports: [AccountService],
})
export class AccountModule {}
