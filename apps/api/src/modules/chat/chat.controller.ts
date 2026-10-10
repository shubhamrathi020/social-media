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
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthUser, CurrentUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ChatService } from './chat.service';
import { CreateConversationDto, MarkReadDto, SendMessageBodyDto } from './dto';

const NUMERIC_ID = /^\d{1,18}$/;

const bigintStr = (v: string | undefined, name: string) => {
  if (v === undefined) return undefined;
  if (!NUMERIC_ID.test(v)) throw new BadRequestException(`${name} must be a numeric id`);
  return v;
};

@Controller()
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get('conversations')
  list(@CurrentUser() u: AuthUser) {
    return this.chat.listConversations(u.userId);
  }

  @Post('conversations')
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateConversationDto) {
    if (dto.userId) return this.chat.openDirect(u.userId, dto.userId);
    return this.chat.createGroup(u.userId, dto.title!, dto.memberIds ?? []);
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
