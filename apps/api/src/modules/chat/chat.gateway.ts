import { HttpException } from '@nestjs/common';
import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { Socket } from 'socket.io';
import { PresenceService } from '../realtime/presence.service';
import { RealtimeService } from '../realtime/realtime.service';
import { ChatService } from './chat.service';
import { DeliveredDto, PresenceQueryDto, ReadEventDto, SendMessageDto, TypingDto } from './dto';

type Ack<T> = { ok: true; data: T } | { ok: false; error: { code: number; message: string } };

async function parse<T extends object>(cls: new () => T, data: unknown): Promise<T> {
  const obj = plainToInstance(cls, data ?? {});
  const errors = await validate(obj as object, { whitelist: true, forbidUnknownValues: true });
  if (errors.length) {
    const msg = errors.flatMap((e) => Object.values(e.constraints ?? {})).join('; ');
    throw new HttpException(msg || 'Invalid payload', 400);
  }
  return obj;
}

/** Runs a handler and converts thrown errors into an ack the client can inspect. */
async function ack<T>(fn: () => Promise<T>): Promise<Ack<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (e instanceof HttpException) {
      const body = e.getResponse();
      const message = typeof body === 'string' ? body : ((body as any).message ?? e.message);
      return {
        ok: false,
        error: { code: e.getStatus(), message: Array.isArray(message) ? message.join('; ') : message },
      };
    }
    return { ok: false, error: { code: 500, message: 'Internal error' } };
  }
}

/** Handlers share the Socket.IO server created by RealtimeGateway; auth already ran as middleware. */
@WebSocketGateway({ cors: { origin: true } })
export class ChatGateway {
  constructor(
    private readonly chat: ChatService,
    private readonly realtime: RealtimeService,
    private readonly presence: PresenceService,
  ) {}

  @SubscribeMessage('message:send')
  send(@ConnectedSocket() s: Socket, @MessageBody() body: unknown) {
    return ack(async () => {
      const dto = await parse(SendMessageDto, body);
      const { message, duplicate } = await this.chat.send(s.data.userId, dto, s.data.sessionId);
      return { message, duplicate };
    });
  }

  @SubscribeMessage('message:delivered')
  delivered(@ConnectedSocket() s: Socket, @MessageBody() body: unknown) {
    return ack(async () => {
      const dto = await parse(DeliveredDto, body);
      await this.chat.markDelivered(s.data.userId, dto.messageIds);
      return {};
    });
  }

  @SubscribeMessage('message:read')
  read(@ConnectedSocket() s: Socket, @MessageBody() body: unknown) {
    return ack(async () => {
      const dto = await parse(ReadEventDto, body);
      await this.chat.markRead(s.data.userId, dto.conversationId, dto.upToMessageId);
      return {};
    });
  }

  @SubscribeMessage('typing:start')
  typingStart(@ConnectedSocket() s: Socket, @MessageBody() body: unknown) {
    return this.typing(s, body, true);
  }

  @SubscribeMessage('typing:stop')
  typingStop(@ConnectedSocket() s: Socket, @MessageBody() body: unknown) {
    return this.typing(s, body, false);
  }

  private typing(s: Socket, body: unknown, isTyping: boolean) {
    return ack(async () => {
      const dto = await parse(TypingDto, body);
      const audience = await this.chat.typingAudience(s.data.userId, dto.conversationId);
      this.realtime.emitToUsers(audience, 'typing', {
        conversationId: dto.conversationId,
        userId: s.data.userId,
        isTyping,
      });
      return {};
    });
  }

  @SubscribeMessage('presence:get')
  presenceGet(@ConnectedSocket() s: Socket, @MessageBody() body: unknown) {
    return ack(async () => {
      const dto = await parse(PresenceQueryDto, body);
      return this.presence.visibleTo(s.data.userId, dto.userIds);
    });
  }
}
