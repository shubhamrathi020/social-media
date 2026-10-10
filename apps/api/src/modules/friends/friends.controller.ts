import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthUser, CurrentUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SendRequestDto, SyncContactsDto } from './dto';
import { FriendsService } from './friends.service';

const uuid = new ParseUUIDPipe();

@Controller()
@UseGuards(JwtAuthGuard)
export class FriendsController {
  constructor(private readonly friends: FriendsService) {}

  // requests
  @Post('friends/requests')
  send(@CurrentUser() u: AuthUser, @Body() dto: SendRequestDto) {
    return this.friends.sendRequest(u.userId, dto.toUser);
  }

  @Get('friends/requests')
  requests(@CurrentUser() u: AuthUser, @Query('direction') direction = 'in') {
    if (direction !== 'in' && direction !== 'out') throw new BadRequestException('direction must be in|out');
    return this.friends.listRequests(u.userId, direction);
  }

  @Post('friends/requests/:id/accept')
  @HttpCode(200)
  accept(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.friends.accept(u.userId, id);
  }

  @Post('friends/requests/:id/decline')
  @HttpCode(204)
  async decline(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    await this.friends.decline(u.userId, id);
  }

  @Post('friends/requests/:id/cancel')
  @HttpCode(204)
  async cancel(@CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    await this.friends.cancel(u.userId, id);
  }

  // suggestions & contacts (declared before friends/:userId)
  @Get('friends/suggestions')
  suggestions(@CurrentUser() u: AuthUser) {
    return this.friends.suggestions(u.userId);
  }

  @Post('friends/suggestions/:userId/dismiss')
  @HttpCode(204)
  async dismiss(@CurrentUser() u: AuthUser, @Param('userId', uuid) userId: string) {
    await this.friends.dismissSuggestion(u.userId, userId);
  }

  @Post('contacts/sync')
  @HttpCode(200)
  sync(@CurrentUser() u: AuthUser, @Body() dto: SyncContactsDto) {
    return this.friends.syncContacts(u.userId, dto.phones);
  }

  @Delete('contacts')
  @HttpCode(204)
  async clearContacts(@CurrentUser() u: AuthUser) {
    await this.friends.deleteContacts(u.userId);
  }

  // friends
  @Get('friends')
  list(@CurrentUser() u: AuthUser, @Query('limit') limit?: string, @Query('before') before?: string) {
    return this.friends.listFriends(u.userId, limit ? Number(limit) || 50 : 50, before);
  }

  @Delete('friends/:userId')
  @HttpCode(204)
  async unfriend(@CurrentUser() u: AuthUser, @Param('userId', uuid) userId: string) {
    await this.friends.unfriend(u.userId, userId);
  }

  // close friends
  @Get('close-friends')
  closeFriends(@CurrentUser() u: AuthUser) {
    return this.friends.listCloseFriends(u.userId);
  }

  @Put('close-friends/:userId')
  @HttpCode(204)
  async addClose(@CurrentUser() u: AuthUser, @Param('userId', uuid) userId: string) {
    await this.friends.addCloseFriend(u.userId, userId);
  }

  @Delete('close-friends/:userId')
  @HttpCode(204)
  async removeClose(@CurrentUser() u: AuthUser, @Param('userId', uuid) userId: string) {
    await this.friends.removeCloseFriend(u.userId, userId);
  }

  // blocks
  @Get('blocks')
  blocked(@CurrentUser() u: AuthUser) {
    return this.friends.listBlocked(u.userId);
  }

  @Put('blocks/:userId')
  @HttpCode(204)
  async block(@CurrentUser() u: AuthUser, @Param('userId', uuid) userId: string) {
    await this.friends.block(u.userId, userId);
  }

  @Delete('blocks/:userId')
  @HttpCode(204)
  async unblock(@CurrentUser() u: AuthUser, @Param('userId', uuid) userId: string) {
    await this.friends.unblock(u.userId, userId);
  }
}
