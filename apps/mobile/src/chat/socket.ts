import { io, Socket } from 'socket.io-client';
import { SOCKET_URL } from '../lib/config';
import { refreshAccessToken, tokens } from '../lib/api';

export type Ack<T> = { ok: true; data: T } | { ok: false; error: { code: number; message: string } };

let socket: Socket | null = null;

/** One authenticated connection for the whole app. Safe to call repeatedly. */
export function connectSocket(): Socket {
  if (socket) return socket;

  socket = io(SOCKET_URL, {
    transports: ['websocket'],
    // Evaluated on every (re)connect so a refreshed access token is used.
    auth: (cb) => cb({ token: tokens.getAccess() }),
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10_000,
  });

  socket.on('connect_error', async (err) => {
    if (err.message === 'unauthorized' && socket) {
      // Handshake token expired: refresh and let socket.io retry with the new one.
      if (await refreshAccessToken()) socket.connect();
    }
  });
  return socket;
}

export function disconnectSocket() {
  socket?.removeAllListeners();
  socket?.disconnect();
  socket = null;
}

export function emitAck<T>(event: string, body: unknown, timeoutMs = 10_000): Promise<Ack<T>> {
  const s = connectSocket();
  return new Promise((resolve) => {
    s.timeout(timeoutMs).emit(event, body, (err: Error | null, res: Ack<T>) => {
      if (err) resolve({ ok: false, error: { code: 0, message: 'Timed out' } });
      else resolve(res);
    });
  });
}
