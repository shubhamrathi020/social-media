import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthUser, CurrentUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UpdateProfileDto } from './dto';
import { UsersService } from './users.service';

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  me(@CurrentUser() u: AuthUser) {
    return this.users.getMe(u.userId);
  }

  @Patch('me')
  update(@CurrentUser() u: AuthUser, @Body() dto: UpdateProfileDto) {
    return this.users.updateMe(u.userId, dto);
  }

  @Delete('me')
  @HttpCode(204)
  async remove(@CurrentUser() u: AuthUser) {
    await this.users.deleteMe(u.userId);
  }

  // Declared before ':id' so "search" is not parsed as an id.
  @Get('search')
  search(@CurrentUser() u: AuthUser, @Query('q') q = '') {
    return this.users.search(q, u.userId);
  }

  @Get(':id')
  byId(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.getPublic(id);
  }
}
