import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccessToken, RoomServiceClient, WebhookReceiver } from 'livekit-server-sdk';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { PG_POOL, REDIS } from '../../common/infra.module';
import { FriendsService } from '../friends/friends.service';
import { MediaService } from '../media/media.service';
import { RealtimeService } from '../realtime/realtime.service';

export interface LiveView {
  id: string;
  title: string;
  audience: 'friends' | 'close_friends';
  status: 'created' | 'live' | 'ended';
  host: { id: string; username: string | null; displayName: string | null; avatarUrl: string | null };
  viewerCount: number;
  heartCount: number;
  startedAt: string | null;
}

export const liveRoom = (id: string) => `live:${id}`;
const TOKEN_TTL = '2h';
const CHAT_HISTORY = 50;

const VISIBLE_LIVE = `(
  s.host_id = $1
  OR (
    s.status = 'live'
    AND NOT EXISTS (SELECT 1 FROM blocks b
                     WHERE (b.blocker_id = $1 AND b.blocked_id = s.host_id)
                        OR (b.blocker_id = s.host_id AND b.blocked_id = $1))
    AND EXISTS (SELECT 1 FROM friendships f
                 WHERE f.user_a = LEAST($1::uuid, s.host_id) AND f.user_b = GREATEST($1::uuid, s.host_id))
    AND (s.audience = 'friends'
         OR EXISTS (SELECT 1 FROM close_friends cf WHERE cf.owner_id = s.host_id AND cf.friend_id = $1))
  )
)`;

const COLS = `s.id, s.title, s.audience, s.status, s.room_name AS "roomName", s.host_id AS "hostId",
  s.heart_count AS "heartCount", s.peak_viewers AS "peakViewers", s.started_at AS "startedAt"`;

@Injectable()
export class LiveService {
  private readonly log = new Logger(LiveService.name);
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly rooms: RoomServiceClient;
  private readonly webhooks: WebhookReceiver;
  readonly publicUrl: string;

  constructor(
    @Inject(PG_POOL) private readonly pg: Pool,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly friends: FriendsService,
    private readonly media: MediaService,
    private readonly realtime: RealtimeService,
    cfg: ConfigService,
  ) {
    this.apiKey = cfg.get('LIVEKIT_API_KEY') ?? 'devkey';
    this.apiSecret = cfg.get('LIVEKIT_API_SECRET') ?? 'devsecret-devsecret-devsecret-devsecret';
    const httpUrl = cfg.get('LIVEKIT_HTTP_URL') ?? 'http://localhost:7880';
    // The URL handed to apps is what *phones* can reach; the server-to-server URL may differ.
    this.publicUrl = cfg.get('LIVEKIT_URL') ?? 'ws://localhost:7880';
    this.rooms = new RoomServiceClient(httpUrl, this.apiKey, this.apiSecret);
    this.webhooks = new WebhookReceiver(this.apiKey, this.apiSecret);
  }

  // ---- host lifecycle ------------------------------------------------------------------------

  async create(host: string, title: string, audience: 'friends' | 'close_friends') {
    const roomName = `live-${randomUUID()}`;
    let id: string;
    try {
      const r = await this.pg.query(
        `INSERT INTO live_streams (host_id, title, audience, room_name) VALUES ($1,$2,$3,$4) RETURNING id`,
        [host, title.trim(), audience, roomName],
      );
      id = r.rows[0].id;
    } catch (e: any) {
      if (e.code === '23505') throw new ConflictException('You already have an unfinished live stream');
      throw e;
    }
    // Creating the room up front lets us fail early if the media server is unreachable.
    try {
      await this.rooms.createRoom({ name: roomName, emptyTimeout: 120, maxParticipants: 1000 });
    } catch (e) {
      await this.pg.query(`UPDATE live_streams SET status = 'ended', ended_at = now() WHERE id = $1`, [id]);
      this.log.error(`LiveKit createRoom failed: ${(e as Error).message}`);
      throw new HttpException('Live streaming is unavailable right now', HttpStatus.SERVICE_UNAVAILABLE);
    }
    return {
      id,
      room: roomName,
      url: this.publicUrl,
      token: await this.token(host, roomName, true),
    };
  }

  /** The host's app calls this after it has connected and published. Friends are told then, not earlier. */
  async start(host: string, id: string): Promise<LiveView> {
    const r = await this.pg.query(
      `UPDATE live_streams SET status = 'live', started_at = COALESCE(started_at, now())
        WHERE id = $1 AND host_id = $2 AND status IN ('created', 'live')
        RETURNING audience, title`,
      [id, host],
    );
    if (!r.rows[0]) throw new NotFoundException('Stream not found or already ended');

    const audience = r.rows[0].audience;
    const ids = audience === 'close_friends' ? await this.friends.closeFriendIds(host) : await this.friends.friendIds(host);
    const view = await this.view(host, id);
    this.realtime.emitToUsers(ids, 'live:started', { liveId: id, hostId: host, title: r.rows[0].title });
    return view;
  }

  async end(host: string, id: string) {
    const r = await this.pg.query(
      `UPDATE live_streams SET status = 'ended', ended_at = now()
        WHERE id = $1 AND host_id = $2 AND status <> 'ended' RETURNING room_name AS "roomName"`,
      [id, host],
    );
    if (!r.rows[0]) throw new NotFoundException('Stream not found or already ended');
    await this.finish(id, r.rows[0].roomName);
  }

  /** Shared by the host ending the stream and by LiveKit reporting the room closed. */
  private async finish(id: string, roomName: string) {
    this.realtime.emitToRoom(liveRoom(id), 'live:ended', { liveId: id });
    await this.rooms.deleteRoom(roomName).catch(() => undefined);
    await this.redis.del(`live:${id}:chat`, `live:${id}:hearts`);
  }

  // ---- viewers ---------------------------------------------------------------------------------

  async join(viewer: string, id: string) {
    const r = await this.pg.query(`SELECT ${COLS} FROM live_streams s WHERE s.id = $2 AND ${VISIBLE_LIVE}`, [
      viewer,
      id,
    ]);
    const s = r.rows[0];
    if (!s || s.status === 'ended') throw new NotFoundException('Stream not found');
    if (s.status !== 'live' && s.hostId !== viewer) throw new NotFoundException('Stream has not started');
    const isHost = s.hostId === viewer;
    return {
      stream: await this.view(viewer, id),
      url: this.publicUrl,
      token: await this.token(viewer, s.roomName, isHost),
      recentChat: await this.recentChat(id),
    };
  }

  async liveNow(viewer: string): Promise<LiveView[]> {
    const r = await this.pg.query(
      `SELECT ${COLS} FROM live_streams s
        WHERE s.status = 'live' AND s.host_id <> $1 AND ${VISIBLE_LIVE}
        ORDER BY s.started_at DESC LIMIT 50`,
      [viewer],
    );
    return this.hydrate(r.rows);
  }

  /** Authorises a socket to join the live room of a stream it may watch. */
  async assertCanWatch(viewer: string, id: string) {
    const r = await this.pg.query(`SELECT s.status FROM live_streams s WHERE s.id = $2 AND ${VISIBLE_LIVE}`, [
      viewer,
      id,
    ]);
    if (!r.rows[0] || r.rows[0].status === 'ended') throw new NotFoundException('Stream not found');
  }

  // ---- chat & hearts ---------------------------------------------------------------------------

  async chat(userId: string, id: string, text: string) {
    await this.assertCanWatch(userId, id);
    const body = text.trim();
    if (!body) throw new BadRequestException('Message is empty');
    await this.rateLimit(`rl:livechat:${userId}`, 1, 1);

    const u = await this.pg.query(
      `SELECT id, username, display_name AS "displayName", avatar_media_id AS "avatarMediaId" FROM users WHERE id = $1`,
      [userId],
    );
    const [author] = await this.media.withAvatarUrls(u.rows);
    const message = {
      id: randomUUID(),
      liveId: id,
      text: body.slice(0, 200),
      at: new Date().toISOString(),
      author: { id: author.id, username: author.username, displayName: author.displayName, avatarUrl: author.avatarUrl },
    };
    await this.redis.lpush(`live:${id}:chat`, JSON.stringify(message));
    await this.redis.ltrim(`live:${id}:chat`, 0, CHAT_HISTORY - 1);
    await this.redis.expire(`live:${id}:chat`, 6 * 3600);
    this.realtime.emitToRoom(liveRoom(id), 'live:chat', message);
    return message;
  }

  async heart(userId: string, id: string) {
    await this.assertCanWatch(userId, id);
    await this.rateLimit(`rl:liveheart:${userId}`, 8, 1);
    const total = await this.redis.incr(`live:${id}:hearts`);
    this.realtime.emitToRoom(liveRoom(id), 'live:heart', { liveId: id, userId, total });
    return { total };
  }

  /** Distinct people watching, not counting the host or several devices of one person. */
  async viewerCount(id: string): Promise<number> {
    const r = await this.pg.query('SELECT host_id FROM live_streams WHERE id = $1', [id]);
    if (!r.rows[0]) return 0;
    const ids = await this.realtime.roomUserIds(liveRoom(id));
    return ids.filter((u) => u !== r.rows[0].host_id).length;
  }

  async refreshViewers(id: string) {
    const count = await this.viewerCount(id);
    await this.recordViewers(id, count);
    return count;
  }

  async recordViewers(id: string, count: number) {
    await this.pg.query(
      'UPDATE live_streams SET peak_viewers = GREATEST(peak_viewers, $2) WHERE id = $1',
      [id, count],
    );
    this.realtime.emitToRoom(liveRoom(id), 'live:viewers', { liveId: id, count });
  }

  // ---- webhooks --------------------------------------------------------------------------------

  /** LiveKit tells us when a room closes (e.g. the host's app crashed). */
  async handleWebhook(rawBody: string, authHeader: string | undefined) {
    let event;
    try {
      event = await this.webhooks.receive(rawBody, authHeader);
    } catch {
      throw new ForbiddenException('Invalid webhook signature');
    }
    if (event.event === 'room_finished' && event.room?.name) {
      const r = await this.pg.query(
        `UPDATE live_streams SET status = 'ended', ended_at = now()
          WHERE room_name = $1 AND status <> 'ended' RETURNING id`,
        [event.room.name],
      );
      for (const row of r.rows) await this.finish(row.id, event.room.name);
    }
  }

  // ---- internals -------------------------------------------------------------------------------

  private async token(identity: string, room: string, canPublish: boolean) {
    const at = new AccessToken(this.apiKey, this.apiSecret, { identity, ttl: TOKEN_TTL });
    at.addGrant({
      roomJoin: true,
      room,
      canPublish,
      canPublishData: canPublish,
      canSubscribe: true,
    });
    return at.toJwt();
  }

  private async recentChat(id: string) {
    const raw = await this.redis.lrange(`live:${id}:chat`, 0, CHAT_HISTORY - 1);
    return raw.map((x) => JSON.parse(x)).reverse();
  }

  private async rateLimit(key: string, max: number, windowSeconds: number) {
    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, windowSeconds);
    if (n > max) throw new HttpException('Slow down', HttpStatus.TOO_MANY_REQUESTS);
  }

  private async view(viewer: string, id: string): Promise<LiveView> {
    const r = await this.pg.query(`SELECT ${COLS} FROM live_streams s WHERE s.id = $2 AND ${VISIBLE_LIVE}`, [
      viewer,
      id,
    ]);
    if (!r.rows[0]) throw new NotFoundException('Stream not found');
    return (await this.hydrate(r.rows))[0];
  }

  private async hydrate(rows: any[]): Promise<LiveView[]> {
    if (rows.length === 0) return [];
    const hosts = await this.pg.query(
      `SELECT id, username, display_name AS "displayName", avatar_media_id AS "avatarMediaId"
         FROM users WHERE id = ANY($1::uuid[])`,
      [[...new Set(rows.map((r) => r.hostId))]],
    );
    const withAvatars = await this.media.withAvatarUrls(hosts.rows);
    return Promise.all(
      rows.map(async (r) => {
        const h = withAvatars.find((x) => x.id === r.hostId)!;
        const hearts = Number((await this.redis.get(`live:${r.id}:hearts`)) ?? r.heartCount);
        return {
          id: r.id,
          title: r.title,
          audience: r.audience,
          status: r.status,
          host: { id: h.id, username: h.username, displayName: h.displayName, avatarUrl: h.avatarUrl },
          viewerCount: (await this.realtime.roomUserIds(liveRoom(r.id))).filter((u) => u !== r.hostId).length,
          heartCount: hearts,
          startedAt: r.startedAt,
        };
      }),
    );
  }
}
