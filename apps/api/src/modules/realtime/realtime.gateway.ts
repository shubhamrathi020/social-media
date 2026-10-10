import { Inject, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import type { Server, Socket } from 'socket.io';
import { REDIS } from '../../common/infra.module';
import { PresenceService } from './presence.service';
import { RealtimeService, userRoom } from './realtime.service';

const HEARTBEAT_MS = 25_000;

/** Owns connection lifecycle: auth, personal room, presence. Feature gateways add their own handlers. */
@WebSocketGateway({ cors: { origin: true }, pingInterval: 20_000, pingTimeout: 20_000 })
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly log = new Logger(RealtimeGateway.name);
  private readonly beats = new Map<string, NodeJS.Timeout>();

  @WebSocketServer() server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly realtime: RealtimeService,
    private readonly presence: PresenceService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  afterInit(server: Server) {
    this.realtime.attach(server);
    // Share rooms across API instances.
    server.adapter(createAdapter(this.redis.duplicate(), this.redis.duplicate()));

    server.use(async (socket, next) => {
      try {
        const token = socket.handshake.auth?.token as string | undefined;
        if (!token) throw new Error('missing token');
        const p = await this.jwt.verifyAsync<{ sub: string; sid: string }>(token);
        socket.data.userId = p.sub;
        socket.data.sessionId = p.sid;
        next();
      } catch {
        next(new Error('unauthorized'));
      }
    });
  }

  async handleConnection(socket: Socket) {
    const userId: string = socket.data.userId;
    await socket.join(userRoom(userId));

    const cameOnline = await this.presence.connect(userId, socket.id);
    this.beats.set(
      socket.id,
      setInterval(() => this.presence.heartbeat(userId, socket.id).catch(() => undefined), HEARTBEAT_MS),
    );
    if (cameOnline) await this.broadcastPresence(userId, true, null);
  }

  async handleDisconnect(socket: Socket) {
    const timer = this.beats.get(socket.id);
    if (timer) clearInterval(timer);
    this.beats.delete(socket.id);

    const userId: string | undefined = socket.data.userId;
    if (!userId) return;
    const wentOffline = await this.presence.disconnect(userId, socket.id).catch(() => false);
    if (wentOffline) await this.broadcastPresence(userId, false, new Date().toISOString());
  }

  private async broadcastPresence(userId: string, online: boolean, lastSeenAt: string | null) {
    try {
      const audience = await this.presence.audience(userId);
      this.realtime.emitToUsers(audience, 'presence', { userId, online, lastSeenAt });
    } catch (e) {
      this.log.warn(`presence broadcast failed: ${(e as Error).message}`);
    }
  }
}
