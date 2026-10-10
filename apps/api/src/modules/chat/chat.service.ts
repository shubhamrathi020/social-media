import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Pool, PoolClient } from 'pg';
import { Events } from '../../common/events';
import { PG_POOL } from '../../common/infra.module';
import { FriendsService } from '../friends/friends.service';
import { MediaService } from '../media/media.service';
import { RealtimeService } from '../realtime/realtime.service';
import { MessagePayload, MessageType, directKey, normalisePayload } from './chat.rules';

const DELETE_FOR_EVERYONE_WINDOW_MS = 48 * 60 * 60 * 1000;

export interface MessageView {
  id: string;
  conversationId: string;
  senderId: string;
  clientMsgId: string;
  type: MessageType | 'system';
  payload: MessagePayload | { encrypted: string };
  replyToId: string | null;
  createdAt: string;
  deleted: boolean;
  status?: 'sent' | 'delivered' | 'read';
  media?: unknown;
}

const MSG_COLS = `m.id, m.conversation_id AS "conversationId", m.sender_id AS "senderId",
  m.client_msg_id AS "clientMsgId", m.type, m.payload, m.enc_version AS "encVersion",
  m.reply_to_id AS "replyToId", m.created_at AS "createdAt", m.deleted_at AS "deletedAt"`;

const STATUS_SQL = `(SELECT CASE WHEN bool_and(r.read_at IS NOT NULL) THEN 'read'
                                 WHEN bool_and(r.delivered_at IS NOT NULL) THEN 'delivered'
                                 ELSE 'sent' END
                       FROM message_receipts r WHERE r.message_id = m.id)`;

@Injectable()
export class ChatService {
  constructor(
    @Inject(PG_POOL) private readonly pg: Pool,
    private readonly friends: FriendsService,
    private readonly media: MediaService,
    private readonly realtime: RealtimeService,
    private readonly events: EventEmitter2,
  ) {}

  // ---- conversations -------------------------------------------------------------------------

  async openDirect(me: string, otherId: string) {
    if (me === otherId) throw new BadRequestException('You cannot message yourself');
    await this.assertCanMessage(me, otherId);

    const key = directKey(me, otherId);
    const client = await this.pg.connect();
    try {
      await client.query('BEGIN');
      const ins = await client.query(
        `INSERT INTO conversations (type, created_by, direct_key) VALUES ('direct', $1, $2)
         ON CONFLICT (direct_key) DO NOTHING RETURNING id`,
        [me, key],
      );
      let id: string;
      if (ins.rows[0]) {
        id = ins.rows[0].id;
        await client.query(
          'INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2),($1,$3)',
          [id, me, otherId],
        );
      } else {
        id = (await client.query('SELECT id FROM conversations WHERE direct_key = $1', [key])).rows[0].id;
      }
      await client.query('COMMIT');
      return this.getConversation(me, id);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async createGroup(me: string, title: string, memberIds: string[]) {
    const others = [...new Set(memberIds)].filter((id) => id !== me);
    if (others.length < 2) throw new BadRequestException('A group needs at least 3 people');
    if (others.length > 255) throw new BadRequestException('Group is too large');
    const rels = await this.friends.relationships(me, others);
    for (const id of others) {
      if (rels.get(id) !== 'friends') throw new BadRequestException('You can only add friends to a group');
    }
    const client = await this.pg.connect();
    try {
      await client.query('BEGIN');
      const c = await client.query(
        `INSERT INTO conversations (type, title, created_by) VALUES ('group', $1, $2) RETURNING id`,
        [title, me],
      );
      const id: string = c.rows[0].id;
      await client.query(
        `INSERT INTO conversation_members (conversation_id, user_id, role)
         SELECT $1, u, CASE WHEN u = $3 THEN 'admin' ELSE 'member' END FROM unnest($2::uuid[]) AS u`,
        [id, [me, ...others], me],
      );
      await client.query('COMMIT');
      this.realtime.emitToUsers([me, ...others], 'conversation:new', { conversationId: id });
      return this.getConversation(me, id);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async listConversations(me: string) {
    const r = await this.pg.query(
      `SELECT c.id, c.type, c.title, c.last_message_at AS "lastMessageAt",
              c.last_message_id AS "lastMessageId",
              (SELECT count(*)::int FROM messages m
                WHERE m.conversation_id = c.id AND m.id > cm.last_read_message_id
                  AND m.sender_id <> $1 AND m.deleted_at IS NULL
                  AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.user_id = $1 AND h.message_id = m.id)
              ) AS unread
         FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
        WHERE cm.user_id = $1
        ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC
        LIMIT 100`,
      [me],
    );
    return this.hydrateConversations(me, r.rows);
  }

  async getConversation(me: string, id: string) {
    await this.assertMember(me, id);
    const r = await this.pg.query(
      `SELECT c.id, c.type, c.title, c.last_message_at AS "lastMessageAt", c.last_message_id AS "lastMessageId",
              (SELECT count(*)::int FROM messages m
                WHERE m.conversation_id = c.id AND m.id > cm.last_read_message_id
                  AND m.sender_id <> $1 AND m.deleted_at IS NULL) AS unread
         FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $1
        WHERE c.id = $2`,
      [me, id],
    );
    return (await this.hydrateConversations(me, r.rows))[0];
  }

  private async hydrateConversations(me: string, rows: any[]) {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const members = await this.pg.query(
      `SELECT cm.conversation_id AS "conversationId", u.id, u.username, u.display_name AS "displayName",
              u.avatar_media_id AS "avatarMediaId", cm.role
         FROM conversation_members cm JOIN users u ON u.id = cm.user_id
        WHERE cm.conversation_id = ANY($1::uuid[])`,
      [ids],
    );
    const withAvatars = await this.media.withAvatarUrls(members.rows);
    const lastIds = rows.map((r) => r.lastMessageId).filter(Boolean);
    const last = new Map<string, MessageView>();
    if (lastIds.length) {
      const m = await this.pg.query(
        `SELECT ${MSG_COLS}, ${STATUS_SQL} AS status FROM messages m WHERE m.id = ANY($1::bigint[])`,
        [lastIds],
      );
      for (const v of await this.toViews(me, m.rows)) last.set(v.id, v);
    }
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      unread: r.unread,
      lastMessageAt: r.lastMessageAt,
      lastMessage: r.lastMessageId ? (last.get(String(r.lastMessageId)) ?? null) : null,
      members: withAvatars
        .filter((m) => m.conversationId === r.id)
        .map(({ conversationId, ...u }) => u),
    }));
  }

  // ---- messages --------------------------------------------------------------------------------

  async send(
    me: string,
    input: { conversationId: string; clientMsgId: string; type: MessageType; payload: unknown; replyToId?: string },
  ): Promise<{ message: MessageView; duplicate: boolean }> {
    const members = await this.memberIds(input.conversationId, me);
    const payload = normalisePayload(input.type, input.payload);

    const conv = await this.pg.query('SELECT type FROM conversations WHERE id = $1', [input.conversationId]);
    if (conv.rows[0].type === 'direct') {
      const other = members.find((id) => id !== me)!;
      await this.assertCanMessage(me, other, { requireSetting: false });
    }
    if (input.type !== 'text') {
      await this.media.assertUsable(me, payload.mediaId!, ['chat']);
      const kind = (await this.media.resolve([payload.mediaId!])).get(payload.mediaId!)?.kind;
      if (kind !== input.type) throw new BadRequestException(`Media is a ${kind}, not ${input.type}`);
    }
    if (input.replyToId) {
      const rep = await this.pg.query('SELECT 1 FROM messages WHERE id = $1 AND conversation_id = $2', [
        input.replyToId,
        input.conversationId,
      ]);
      if (rep.rowCount === 0) throw new BadRequestException('Reply target not found in this conversation');
    }

    const client = await this.pg.connect();
    let row: any;
    let duplicate = false;
    try {
      await client.query('BEGIN');
      const ins = await client.query(
        `INSERT INTO messages (conversation_id, sender_id, client_msg_id, type, payload, reply_to_id)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (conversation_id, sender_id, client_msg_id) DO NOTHING
         RETURNING id`,
        [
          input.conversationId,
          me,
          input.clientMsgId,
          input.type,
          Buffer.from(JSON.stringify(payload), 'utf8'),
          input.replyToId ?? null,
        ],
      );
      let id: string;
      if (ins.rows[0]) {
        id = ins.rows[0].id;
        const others = members.filter((m) => m !== me);
        if (others.length) {
          await client.query(
            'INSERT INTO message_receipts (message_id, user_id) SELECT $1, unnest($2::uuid[])',
            [id, others],
          );
        }
        await client.query(
          'UPDATE conversations SET last_message_id = $2, last_message_at = now() WHERE id = $1',
          [input.conversationId, id],
        );
        // Sending implies the sender has read everything up to here.
        await client.query(
          `UPDATE conversation_members SET last_read_message_id = GREATEST(last_read_message_id, $3)
            WHERE conversation_id = $1 AND user_id = $2`,
          [input.conversationId, me, id],
        );
      } else {
        duplicate = true;
        id = (
          await client.query(
            'SELECT id FROM messages WHERE conversation_id = $1 AND sender_id = $2 AND client_msg_id = $3',
            [input.conversationId, me, input.clientMsgId],
          )
        ).rows[0].id;
      }
      row = (
        await client.query(`SELECT ${MSG_COLS}, ${STATUS_SQL} AS status FROM messages m WHERE m.id = $1`, [id])
      ).rows[0];
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }

    const [message] = await this.toViews(me, [row]);
    if (!duplicate) {
      this.realtime.emitToUsers(members, 'message:new', message);
      const label: Record<string, string> = {
        image: 'Photo',
        video: 'Video',
        audio: 'Voice message',
        file: 'File',
      };
      this.events.emit(Events.MessageCreated, {
        conversationId: input.conversationId,
        messageId: message.id,
        senderId: me,
        recipientIds: members.filter((m) => m !== me),
        type: input.type,
        preview: input.type === 'text' ? (payload.text ?? '').slice(0, 100) : (label[input.type] ?? 'New message'),
      });
    }
    return { message, duplicate };
  }

  async history(me: string, conversationId: string, before?: string, limit = 30) {
    await this.assertMember(me, conversationId);
    const r = await this.pg.query(
      `SELECT ${MSG_COLS}, ${STATUS_SQL} AS status
         FROM messages m
        WHERE m.conversation_id = $2 AND ($3::bigint IS NULL OR m.id < $3)
          AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.user_id = $1 AND h.message_id = m.id)
        ORDER BY m.id DESC LIMIT $4`,
      [me, conversationId, before ?? null, Math.min(limit, 100)],
    );
    return this.toViews(me, r.rows);
  }

  /** Everything addressed to me after a cursor; clients call this after (re)connecting. */
  async sync(me: string, after: string, limit = 200) {
    const r = await this.pg.query(
      `SELECT ${MSG_COLS}, ${STATUS_SQL} AS status
         FROM messages m
         JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1
        WHERE m.id > $2::bigint
          AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.user_id = $1 AND h.message_id = m.id)
        ORDER BY m.id ASC LIMIT $3`,
      [me, after, Math.min(limit, 500)],
    );
    return this.toViews(me, r.rows);
  }

  async markDelivered(me: string, messageIds: string[]) {
    if (messageIds.length === 0) return;
    const r = await this.pg.query(
      `UPDATE message_receipts SET delivered_at = now()
        WHERE user_id = $1 AND message_id = ANY($2::bigint[]) AND delivered_at IS NULL
        RETURNING message_id AS "messageId"`,
      [me, messageIds.slice(0, 500)],
    );
    if (r.rowCount === 0) return;
    const m = await this.pg.query(
      'SELECT id, sender_id AS "senderId", conversation_id AS "conversationId" FROM messages WHERE id = ANY($1::bigint[])',
      [r.rows.map((x) => x.messageId)],
    );
    for (const row of m.rows) {
      this.realtime.emitToUsers([row.senderId], 'message:status', {
        messageId: row.id,
        conversationId: row.conversationId,
        userId: me,
        status: 'delivered',
      });
    }
  }

  async markRead(me: string, conversationId: string, upToMessageId: string) {
    const members = await this.memberIds(conversationId, me);
    await this.pg.query(
      `UPDATE conversation_members SET last_read_message_id = GREATEST(last_read_message_id, $3::bigint)
        WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, me, upToMessageId],
    );
    await this.pg.query(
      `UPDATE message_receipts SET read_at = now(), delivered_at = COALESCE(delivered_at, now())
        WHERE user_id = $1 AND read_at IS NULL
          AND message_id IN (SELECT id FROM messages WHERE conversation_id = $2 AND id <= $3::bigint)`,
      [me, conversationId, upToMessageId],
    );
    this.realtime.emitToUsers(members, 'conversation:read', { conversationId, userId: me, upToMessageId });
  }

  async deleteMessage(me: string, messageId: string, scope: 'me' | 'everyone') {
    const r = await this.pg.query(
      'SELECT id, sender_id AS "senderId", conversation_id AS "conversationId", created_at AS "createdAt" FROM messages WHERE id = $1',
      [messageId],
    );
    const m = r.rows[0];
    if (!m) throw new NotFoundException();
    const members = await this.memberIds(m.conversationId, me);

    if (scope === 'me') {
      await this.pg.query(
        'INSERT INTO message_hidden (user_id, message_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [me, messageId],
      );
      return;
    }
    if (m.senderId !== me) throw new ForbiddenException('You can only delete your own messages for everyone');
    if (Date.now() - new Date(m.createdAt).getTime() > DELETE_FOR_EVERYONE_WINDOW_MS) {
      throw new ConflictException('Too old to delete for everyone');
    }
    await this.pg.query(
      `UPDATE messages SET deleted_at = now(), payload = $2 WHERE id = $1 AND deleted_at IS NULL`,
      [messageId, Buffer.from('{}', 'utf8')],
    );
    this.realtime.emitToUsers(members, 'message:deleted', {
      messageId,
      conversationId: m.conversationId,
      scope: 'everyone',
    });
  }

  /** Other members to notify about typing. Throws if `me` is not a member. */
  async typingAudience(me: string, conversationId: string): Promise<string[]> {
    return (await this.memberIds(conversationId, me)).filter((id) => id !== me);
  }

  // ---- helpers ---------------------------------------------------------------------------------

  private async memberIds(conversationId: string, me: string): Promise<string[]> {
    const r = await this.pg.query('SELECT user_id FROM conversation_members WHERE conversation_id = $1', [
      conversationId,
    ]);
    const ids: string[] = r.rows.map((x) => x.user_id);
    // 404 rather than 403: do not reveal that a conversation exists.
    if (!ids.includes(me)) throw new NotFoundException('Conversation not found');
    return ids;
  }

  private async assertMember(me: string, conversationId: string) {
    await this.memberIds(conversationId, me);
  }

  /**
   * Starting a conversation requires that the target's "who can message me" setting allows it.
   * Once a conversation exists only blocks stop it, so changing a privacy setting does not
   * retroactively kill chats between friends.
   */
  private async assertCanMessage(me: string, otherId: string, opts: { requireSetting: boolean } = { requireSetting: true }) {
    const rel = (await this.friends.relationships(me, [otherId])).get(otherId)!;
    if (rel === 'blocked' || rel === 'blocked_by') throw new ForbiddenException('You cannot message this user');
    if (!opts.requireSetting) return;

    const u = await this.pg.query(
      `SELECT COALESCE(s.privacy->>'messages', 'friends') AS setting
         FROM users u LEFT JOIN user_settings s ON s.user_id = u.id
        WHERE u.id = $1 AND u.deleted_at IS NULL`,
      [otherId],
    );
    if (!u.rows[0]) throw new NotFoundException('User not found');
    const setting: string = u.rows[0].setting;
    if (setting === 'nobody' || (setting === 'friends' && rel !== 'friends')) {
      throw new ForbiddenException('This user does not accept messages from you');
    }
  }

  private async toViews(me: string, rows: any[]): Promise<MessageView[]> {
    const parsed = rows.map((row) => {
      let payload: any;
      if (row.deletedAt) payload = {};
      else if (row.encVersion === 0) payload = JSON.parse((row.payload as Buffer).toString('utf8'));
      else payload = { encrypted: (row.payload as Buffer).toString('base64') };
      return { row, payload };
    });
    const mediaIds = parsed.map((p) => p.payload.mediaId).filter(Boolean) as string[];
    const media = await this.media.resolve(mediaIds);
    return parsed.map(({ row, payload }) => ({
      id: String(row.id),
      conversationId: row.conversationId,
      senderId: row.senderId,
      clientMsgId: row.clientMsgId,
      type: row.type,
      payload,
      replyToId: row.replyToId ? String(row.replyToId) : null,
      createdAt: row.createdAt,
      deleted: !!row.deletedAt,
      status: row.senderId === me ? (row.status ?? 'sent') : undefined,
      media: payload.mediaId ? media.get(payload.mediaId) : undefined,
    }));
  }
}
