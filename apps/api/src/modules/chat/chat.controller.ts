import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthUser, CurrentUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ChatService } from './chat.service';
import { GroupsService } from './groups.service';
import {
  AddMembersDto,
  CreateConversationDto,
  MarkReadDto,
  MuteDto,
  SendMessageBodyDto,
  SetRoleDto,
  UpdateGroupDto,
} from './dto';

const NUMERIC_ID = /^\d{1,18}$/;

const bigintStr = (v: string | undefined, name: string) => {
  if (v === undefined) return undefined;
  if (!NUMERIC_ID.test(v)) throw new BadRequestException(`${name} must be a numeric id`);
  return v;
};

@Controller()
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(
    private readonly chat: ChatService,
    private readonly groups: GroupsService,
  ) {}

  @Get('conversations')
  list(@CurrentUser() u: AuthUser) {
    return this.chat.listConversations(u.userId);
  }

  @Post('conversations')
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateConversationDto) {
    if (dto.userId) return this.chat.openDirect(u.userId, dto.userId);
    return this.chat.createGroup(u.userId, dto.title!, dto.memberIds ?? []);
  }

  // ---- group administration ----

  @Patch('conversations/:id')
  updateGroup(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateGroupDto) {
    return this.groups.update(u.userId, id, dto);
  }

  @Post('conversations/:id/members')
  addMembers(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddMembersDto) {
    return this.groups.addMembers(u.userId, id, dto.userIds);
  }

  @Delete('conversations/:id/members/:userId')
  removeMember(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.groups.removeMember(u.userId, id, userId);
  }

  @Post('conversations/:id/leave')
  @HttpCode(200)
  leave(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.groups.removeMember(u.userId, id, u.userId);
  }

  @Patch('conversations/:id/members/:userId')
  setRole(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: SetRoleDto,
  ) {
    return this.groups.setRole(u.userId, id, userId, dto.role);
  }

  @Put('conversations/:id/mute')
  mute(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: MuteDto) {
    return this.groups.mute(u.userId, id, dto.mutedUntil ? new Date(dto.mutedUntil) : null);
  }

  @Get('conversations/:id/messages')
  history(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ) {
    return this.chat.history(u.userId, id, bigintStr(before, 'before'), limit ? Number(limit) || 30 : 30);
  }

  /** HTTP fallback for sending; the socket event is preferred. */
  @Post('conversations/:id/messages')
  async send(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendMessageBodyDto,
  ) {
    const { message } = await this.chat.send(u.userId, { ...dto, conversationId: id });
    return message;
  }

  @Post('conversations/:id/read')
  @HttpCode(204)
  async read(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: MarkReadDto) {
    await this.chat.markRead(u.userId, id, dto.upToMessageId);
  }

  @Delete('messages/:id')
  @HttpCode(204)
  async remove(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('scope') scope = 'me') {
    if (!NUMERIC_ID.test(id)) throw new BadRequestException('Invalid message id');
    if (scope !== 'me' && scope !== 'everyone') throw new BadRequestException('scope must be me|everyone');
    await this.chat.deleteMessage(u.userId, id, scope);
  }

  /** Messages after a cursor, for catching up after being offline. */
  @Get('chat/sync')
  sync(@CurrentUser() u: AuthUser, @Query('after') after = '0', @Query('limit') limit?: string) {
    return this.chat.sync(u.userId, bigintStr(after, 'after')!, limit ? Number(limit) || 200 : 200);
  }
}
