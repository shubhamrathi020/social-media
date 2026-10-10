import { Injectable } from '@nestjs/common';
import type { Server } from 'socket.io';

export const userRoom = (userId: string) => `user:${userId}`;

/**
 * Lets any module push events to users without knowing about sockets.
 * The Socket.IO server is attached by RealtimeGateway once it starts.
 */
@Injectable()
export class RealtimeService {
  private server: Server | null = null;

  attach(server: Server) {
    this.server = server;
  }

  emitToUsers(userIds: string[], event: string, payload: unknown) {
    if (!this.server || userIds.length === 0) return;
    this.server.to([...new Set(userIds)].map(userRoom)).emit(event, payload);
  }

  /** Distinct user ids with a socket in the room, across all API instances (uses the Redis adapter). */
  async roomUserIds(room: string): Promise<string[]> {
    if (!this.server) return [];
    const sockets = await this.server.in(room).fetchSockets();
    return [...new Set(sockets.map((s) => s.data.userId as string).filter(Boolean))];
  }

  /** Emit to every socket subscribed to an arbitrary room (e.g. `post:{id}`). */
  emitToRoom(room: string, event: string, payload: unknown) {
    this.server?.to(room).emit(event, payload);
  }
}
