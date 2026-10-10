import { HttpException } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { plainToInstance } from 'class-transformer';
import { IsString, IsUUID, Length, validate } from 'class-validator';
import type { Socket } from 'socket.io';
import { LiveService, liveRoom } from './live.service';

class LiveRefDto {
  @IsUUID()
  liveId!: string;
}

class LiveChatDto extends LiveRefDto {
  @IsString()
  @Length(1, 200)
  text!: string;
}

async function parse<T extends object>(cls: new () => T, data: unknown): Promise<T> {
  const obj = plainToInstance(cls, data ?? {});
  if ((await validate(obj as object, { whitelist: true })).length) throw new HttpException('Invalid payload', 400);
  return obj;
}

async function ack<T>(fn: () => Promise<T>) {
  try {
    return { ok: true as const, data: await fn() };
  } catch (e) {
    if (e instanceof HttpException) return { ok: false as const, error: { code: e.getStatus(), message: e.message } };
    return { ok: false as const, error: { code: 500, message: 'Internal error' } };
  }
}

@WebSocketGateway({ cors: { origin: true } })
export class LiveGateway implements OnGatewayDisconnect {
  constructor(private readonly live: LiveService) {}

  @SubscribeMessage('live:join')
  join(@ConnectedSocket() s: Socket, @MessageBody() body: unknown) {
    return ack(async () => {
      const { liveId } = await parse(LiveRefDto, body);
      await this.live.assertCanWatch(s.data.userId, liveId);
      await s.join(liveRoom(liveId));
      (s.data.liveIds ??= new Set<string>()).add(liveId);
      return { viewerCount: await this.live.refreshViewers(liveId) };
    });
  }

  @SubscribeMessage('live:leave')
  leave(@ConnectedSocket() s: Socket, @MessageBody() body: unknown) {
    return ack(async () => {
      const { liveId } = await parse(LiveRefDto, body);
      await s.leave(liveRoom(liveId));
      s.data.liveIds?.delete(liveId);
      await this.live.refreshViewers(liveId);
      return {};
    });
  }

  @SubscribeMessage('live:chat')
  chat(@ConnectedSocket() s: Socket, @MessageBody() body: unknown) {
    return ack(async () => {
      const dto = await parse(LiveChatDto, body);
      return this.live.chat(s.data.userId, dto.liveId, dto.text);
    });
  }

  @SubscribeMessage('live:heart')
  heart(@ConnectedSocket() s: Socket, @MessageBody() body: unknown) {
    return ack(async () => {
      const { liveId } = await parse(LiveRefDto, body);
      return this.live.heart(s.data.userId, liveId);
    });
  }

  /** Socket.IO has already removed the socket from its rooms; refresh the counts of the ones it was in. */
  async handleDisconnect(s: Socket) {
    const ids: Set<string> | undefined = s.data.liveIds;
    if (!ids) return;
    for (const liveId of ids) {
      await this.live.refreshViewers(liveId).catch(() => undefined);
    }
  }
}
