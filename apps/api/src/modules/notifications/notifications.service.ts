import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Pool } from 'pg';
import { PG_POOL } from '../../common/infra.module';
import {
  CommentCreatedEvent,
  Events,
  FriendAcceptedEvent,
  FriendRequestEvent,
  LiveStartedEvent,
  MessageCreatedEvent,
  PostLikedEvent,
} from '../../common/events';
import { MediaService } from '../media/media.service';
import { PresenceService } from '../realtime/presence.service';
import { RealtimeService } from '../realtime/realtime.service';
import { PushMessage, PushSender } from './push-sender';

type NotificationType =
  | 'friend_request'
  | 'friend_accepted'
  | 'post_liked'
  | 'comment'
  | 'comment_reply'
  | 'live_started';

/** Which user-facing toggle (settings.notifications.*) controls each type. */
const PREF_KEY: Record<NotificationType | 'message', string> = {
  friend_request: 'friendRequests',
  friend_accepted: 'friendRequests',
  post_liked: 'likes',
  comment: 'comments',
  comment_reply: 'comments',
  live_started: 'live',
  message: 'messages',
};

export interface NotificationView {
  id: string;
  type: NotificationType;
  actor: { id: string; username: string | null; displayName: string | null; avatarUrl: string | null } | null;
  entityType: string | null;
  entityId: string | null;
  data: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

@Injectable()
export class NotificationsService {
  private readonly log = new Logger(NotificationsService.name);

  constructor(
    @Inject(PG_POOL) private readonly pg: Pool,
    private readonly push: PushSender,
    private readonly realtime: RealtimeService,
    private readonly presence: PresenceService,
    private readonly media: MediaService,
  ) {}

  // ---- domain events ---------------------------------------------------------------------------

  @OnEvent(Events.FriendRequest)
  onFriendRequest(e: FriendRequestEvent) {
    return this.notify([e.toUserId], 'friend_request', e.fromUserId, {
      entityType: 'friend_request',
      entityId: e.requestId,
      text: (n) => `${n} sent you a friend request`,
    });
  }

  @OnEvent(Events.FriendAccepted)
  onFriendAccepted(e: FriendAcceptedEvent) {
    return this.notify([e.requesterId], 'friend_accepted', e.accepterId, {
      entityType: 'user',
      entityId: e.accepterId,
      text: (n) => `${n} accepted your friend request`,
    });
  }

  @OnEvent(Events.PostLiked)
  onPostLiked(e: PostLikedEvent) {
    return this.notify([e.authorId], 'post_liked', e.actorId, {
      entityType: 'post',
      entityId: e.postId,
      text: (n) => `${n} liked your post`,
    });
  }

  @OnEvent(Events.CommentCreated)
  async onComment(e: CommentCreatedEvent) {
    const replyTarget = e.parentAuthorId;
    if (replyTarget) {
      await this.notify([replyTarget], 'comment_reply', e.actorId, {
        entityType: 'post',
        entityId: e.postId,
        data: { commentId: e.commentId, preview: e.preview },
        text: (n) => `${n} replied: ${e.preview}`,
      });
    }
    // The post author hears about it too, unless they were just told about the reply.
    if (e.postAuthorId !== replyTarget) {
      await this.notify([e.postAuthorId], 'comment', e.actorId, {
        entityType: 'post',
        entityId: e.postId,
        data: { commentId: e.commentId, preview: e.preview },
        text: (n) => `${n} commented: ${e.preview}`,
      });
    }
  }

  @OnEvent(Events.LiveStarted)
  onLive(e: LiveStartedEvent) {
    return this.notify(e.audienceIds, 'live_started', e.hostId, {
      entityType: 'live',
      entityId: e.liveId,
      data: { title: e.title },
      text: (n) => `${n} is live${e.title ? `: ${e.title}` : ''}`,
    });
  }

  /** Messages are pushed to people who are not connected, but are not kept in the notification inbox. */
  @OnEvent(Events.MessageCreated)
  async onMessage(e: MessageCreatedEvent) {
    const offline: string[] = [];
    for (const id of e.recipientIds) {
      if (!(await this.presence.isOnline(id))) offline.push(id);
    }
    if (offline.length === 0) return;

    const [allowed, actor] = await Promise.all([
      this.allowedUsers(offline, 'message', e.conversationId),
      this.actor(e.senderId),
    ]);
    await this.pushTo(allowed, {
      title: actor?.displayName ?? actor?.username ?? 'New message',
      body: e.preview,
      data: { type: 'message', conversationId: e.conversationId, messageId: e.messageId },
    });
  }

  // ---- inbox API -------------------------------------------------------------------------------

  async list(userId: string, cursor?: string, limit = 30) {
    const n = Math.min(limit, 50);
    const r = await this.pg.query(
      `SELECT id, seq, type, actor_id AS "actorId", entity_type AS "entityType", entity_id AS "entityId",
              data, read_at AS "readAt", created_at AS "createdAt"
         FROM notifications
        WHERE user_id = $1 AND ($2::bigint IS NULL OR seq < $2)
        ORDER BY seq DESC LIMIT $3`,
      [userId, cursor ?? null, n + 1],
    );
    const more = r.rows.length > n;
    const rows = more ? r.rows.slice(0, n) : r.rows;
    return {
      items: await this.toViews(rows),
      nextCursor: more ? String(rows[rows.length - 1].seq) : null,
    };
  }

  async unreadCount(userId: string) {
    const r = await this.pg.query(
      'SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL',
      [userId],
    );
    return { unread: r.rows[0].n as number };
  }

  async markRead(userId: string, ids?: string[]) {
    await this.pg.query(
      `UPDATE notifications SET read_at = now()
        WHERE user_id = $1 AND read_at IS NULL AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))`,
      [userId, ids ?? null],
    );
    return this.unreadCount(userId);
  }

  /** Attaches the push token to the device that owns this session. */
  async registerPushToken(sessionId: string, token: string | null) {
    await this.pg.query(
      `UPDATE devices SET push_token = $2, last_active_at = now()
        WHERE id = (SELECT device_id FROM sessions WHERE id = $1 AND revoked_at IS NULL)`,
      [sessionId, token],
    );
    if (token) {
      // A token belongs to one device: if it moved to another account on this phone, drop the old claim.
      await this.pg.query(
        `UPDATE devices SET push_token = NULL
          WHERE push_token = $2 AND id <> (SELECT device_id FROM sessions WHERE id = $1)`,
        [sessionId, token],
      );
    }
  }

  // ---- internals -------------------------------------------------------------------------------

  private async notify(
    recipients: string[],
    type: NotificationType,
    actorId: string,
    o: { entityType: string; entityId: string; data?: Record<string, unknown>; text: (actorName: string) => string },
  ) {
    const targets = [...new Set(recipients)].filter((id) => id !== actorId);
    if (targets.length === 0) return;
    try {
      const [allowed, actor] = await Promise.all([this.allowedUsers(targets, type), this.actor(actorId)]);
      if (allowed.length === 0) return;

      const name = actor?.displayName ?? actor?.username ?? 'Someone';
      const inserted = await this.pg.query(
        `INSERT INTO notifications (user_id, type, actor_id, entity_type, entity_id, data)
         SELECT u, $2, $3, $4, $5, $6::jsonb FROM unnest($1::uuid[]) AS u
         ON CONFLICT DO NOTHING
         RETURNING id, user_id AS "userId", created_at AS "createdAt"`,
        [allowed, type, actorId, o.entityType, o.entityId, JSON.stringify(o.data ?? {})],
      );
      const fresh = inserted.rows as { id: string; userId: string; createdAt: string }[];
      if (fresh.length === 0) return;

      for (const row of fresh) {
        this.realtime.emitToUsers([row.userId], 'notification:new', {
          id: row.id,
          type,
          actor,
          entityType: o.entityType,
          entityId: o.entityId,
          data: o.data ?? {},
          readAt: null,
          createdAt: row.createdAt,
        });
      }
      await this.pushTo(
        fresh.map((f) => f.userId),
        {
          title: 'Social',
          body: o.text(name),
          data: { type, entityType: o.entityType, entityId: o.entityId },
        },
      );
    } catch (e) {
      this.log.warn(`notify ${type} failed: ${(e as Error).message}`);
    }
  }

  /** Users whose notification settings allow this kind of notification, minus muted conversations. */
  private async allowedUsers(userIds: string[], type: NotificationType | 'message', conversationId?: string) {
    const key = PREF_KEY[type];
    const r = await this.pg.query(
      `SELECT u.id
         FROM users u
         LEFT JOIN user_settings s ON s.user_id = u.id
        WHERE u.id = ANY($1::uuid[]) AND u.deleted_at IS NULL
          AND COALESCE((s.notifications->>$2)::boolean, true)
          AND ($3::uuid IS NULL OR NOT EXISTS (
                SELECT 1 FROM conversation_members cm
                 WHERE cm.conversation_id = $3 AND cm.user_id = u.id AND cm.muted_until > now()))`,
      [userIds, key, conversationId ?? null],
    );
    return r.rows.map((x) => x.id as string);
  }

  private async pushTo(userIds: string[], payload: Omit<PushMessage, 'to'>) {
    if (userIds.length === 0) return;
    const t = await this.pg.query(
      `SELECT DISTINCT push_token FROM devices
        WHERE user_id = ANY($1::uuid[]) AND push_token IS NOT NULL
          AND id IN (SELECT device_id FROM sessions WHERE revoked_at IS NULL AND expires_at > now())`,
      [userIds],
    );
    const tokens: string[] = t.rows.map((x) => x.push_token);
    if (tokens.length === 0) return;
    const { invalidTokens } = await this.push.send(tokens.map((to) => ({ ...payload, to })));
    if (invalidTokens.length) {
      await this.pg.query('UPDATE devices SET push_token = NULL WHERE push_token = ANY($1::text[])', [invalidTokens]);
    }
  }

  private async actor(id: string) {
    const r = await this.pg.query(
      `SELECT id, username, display_name AS "displayName", avatar_media_id AS "avatarMediaId"
         FROM users WHERE id = $1`,
      [id],
    );
    if (!r.rows[0]) return null;
    const [a] = await this.media.withAvatarUrls(r.rows);
    return { id: a.id, username: a.username, displayName: a.displayName, avatarUrl: a.avatarUrl };
  }

  private async toViews(rows: any[]): Promise<NotificationView[]> {
    const actorIds = [...new Set(rows.map((r) => r.actorId).filter(Boolean))];
    const users = actorIds.length
      ? await this.pg.query(
          `SELECT id, username, display_name AS "displayName", avatar_media_id AS "avatarMediaId"
             FROM users WHERE id = ANY($1::uuid[])`,
          [actorIds],
        )
      : { rows: [] as any[] };
    const withAvatars = await this.media.withAvatarUrls(users.rows);
    const byId = new Map(
      withAvatars.map((u) => [u.id, { id: u.id, username: u.username, displayName: u.displayName, avatarUrl: u.avatarUrl }]),
    );
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      actor: r.actorId ? (byId.get(r.actorId) ?? null) : null,
      entityType: r.entityType,
      entityId: r.entityId,
      data: r.data,
      readAt: r.readAt,
      createdAt: r.createdAt,
    }));
  }
}
