import { HttpException } from '@nestjs/common';
import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import { plainToInstance } from 'class-transformer';
import { IsIn, IsOptional, IsUUID, validate } from 'class-validator';
import type { Socket } from 'socket.io';
import { PostsService } from './posts.service';

class PostRefDto {
  @IsUUID()
  postId!: string;
}

class PostReactDto extends PostRefDto {
  /** 1 = like, -1 = dislike, null = clear */
  @IsOptional()
  @IsIn([1, -1])
  value?: 1 | -1 | null;
}

async function parse<T extends object>(cls: new () => T, data: unknown): Promise<T> {
  const obj = plainToInstance(cls, data ?? {});
  const errors = await validate(obj as object, { whitelist: true });
  if (errors.length) throw new HttpException('Invalid payload', 400);
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

/** Clients subscribe to a post while it is on screen to receive live counters and comments. */
@WebSocketGateway({ cors: { origin: true } })
export class PostsGateway {
  constructor(private readonly posts: PostsService) {}

  @SubscribeMessage('post:subscribe')
  subscribe(@ConnectedSocket() s: Socket, @MessageBody() body: unknown) {
    return ack(async () => {
      const { postId } = await parse(PostRefDto, body);
      await this.posts.assertVisible(s.data.userId, postId);
      await s.join(`post:${postId}`);
      return {};
    });
  }

  @SubscribeMessage('post:unsubscribe')
  unsubscribe(@ConnectedSocket() s: Socket, @MessageBody() body: unknown) {
    return ack(async () => {
      const { postId } = await parse(PostRefDto, body);
      await s.leave(`post:${postId}`);
      return {};
    });
  }

  @SubscribeMessage('post:react')
  react(@ConnectedSocket() s: Socket, @MessageBody() body: unknown) {
    return ack(async () => {
      const dto = await parse(PostReactDto, body);
      return this.posts.react(s.data.userId, dto.postId, dto.value ?? null);
    });
  }
}
