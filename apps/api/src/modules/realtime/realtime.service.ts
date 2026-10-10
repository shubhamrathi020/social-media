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

  /** Emit to every socket subscribed to an arbitrary room (e.g. `post:{id}`). */
  emitToRoom(room: string, event: string, payload: unknown) {
    this.server?.to(room).emit(event, payload);
  }
}
