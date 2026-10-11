import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'crypto';
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
  /** Present for end-to-end encrypted messages; `payload` is then empty. */
  encrypted?: {
    version: number;
    ciphertext: string;
    senderDeviceId: string | null;
    senderKey: string | null;
    /** device id -> sealed message key */
    keys: Record<string, string>;
  };
}

const MSG_COLS = `m.id, m.conversation_id AS "conversationId", m.sender_id AS "senderId",
  m.client_msg_id AS "clientMsgId", m.type, m.payload, m.enc_version AS "encVersion",
  m.reply_to_id AS "replyToId", m.created_at AS "createdAt", m.deleted_at AS "deletedAt",
  m.sender_device_id AS "senderDeviceId", m.attachment_media_id AS "attachmentId"`;

/** Largest encrypted message body accepted (base64 of nonce + ciphertext). */
const MAX_CIPHERTEXT_BYTES = 64 * 1024;

export interface EncryptedInput {
  ciphertext: string;
  keys: { deviceId: string; box: string }[];
}

/** Which envelopes to include: all (socket broadcast, each device picks its own), one device, or none. */
type KeyScope = { deviceId?: string | null };

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
      const e2e = await this.everyoneHasKeys([me, otherId]);
      const ins = await client.query(
        `INSERT INTO conversations (type, created_by, direct_key, e2e) VALUES ('direct', $1, $2, $3)
         ON CONFLICT (direct_key) DO NOTHING RETURNING id`,
        [me, key, e2e],
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
      const e2e = await this.everyoneHasKeys([me, ...others]);
      const c = await client.query(
        `INSERT INTO conversations (type, title, created_by, e2e) VALUES ('group', $1, $2, $3) RETURNING id`,
        [title, me, e2e],
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
                  AND m.created_at >= cm.joined_at AND m.type <> 'system'
                  AND m.sender_id <> $1 AND m.deleted_at IS NULL
                  AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.user_id = $1 AND h.message_id = m.id)
              ) AS unread,
              c.avatar_media_id AS "avatarMediaId", cm.role AS "myRole", cm.muted_until AS "mutedUntil",
              c.e2e
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
                  AND m.created_at >= cm.joined_at AND m.type <> 'system'
                  AND m.sender_id <> $1 AND m.deleted_at IS NULL) AS unread,
              c.avatar_media_id AS "avatarMediaId", cm.role AS "myRole", cm.muted_until AS "mutedUntil",
              c.e2e
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
    const groupAvatars = await this.media.resolve(rows.map((r) => r.avatarMediaId).filter(Boolean));
    const lastIds = rows.map((r) => r.lastMessageId).filter(Boolean);
    const last = new Map<string, MessageView>();
    if (lastIds.length) {
      const m = await this.pg.query(
        `SELECT ${MSG_COLS}, ${STATUS_SQL} AS status FROM messages m WHERE m.id = ANY($1::bigint[])`,
        [lastIds],
      );
      for (const v of await this.toViews(me, m.rows, { deviceId: null })) last.set(v.id, v);
    }
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      e2e: !!r.e2e,
      avatarUrl: r.avatarMediaId ? (groupAvatars.get(r.avatarMediaId)?.thumbUrl ?? null) : null,
      myRole: r.myRole as 'admin' | 'member',
      mutedUntil: r.mutedUntil as string | null,
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
    input: {
      conversationId: string;
      clientMsgId: string;
      type: MessageType;
      payload?: unknown;
      replyToId?: string;
      encrypted?: EncryptedInput;
      attachmentId?: string;
    },
    sessionId?: string,
  ): Promise<{ message: MessageView; duplicate: boolean }> {
    const members = await this.memberIds(input.conversationId, me);

    const conv = await this.pg.query('SELECT type, e2e FROM conversations WHERE id = $1', [input.conversationId]);
    if (conv.rows[0].type === 'direct') {
      const other = members.find((id) => id !== me)!;
      await this.assertCanMessage(me, other, { requireSetting: false });
    }

    let payload: MessagePayload = {};
    let body: Buffer;
    let encVersion = 0;
    let senderDeviceId: string | null = null;
    if (conv.rows[0].e2e) {
      // The server cannot read these messages, so it cannot accept plaintext in them either (no downgrade).
      if (!input.encrypted) {
        throw new BadRequestException('This conversation is end-to-end encrypted; send an encrypted message');
      }
      const device = sessionId ? await this.deviceOfSession(sessionId) : null;
      if (!device?.hasKey) throw new BadRequestException("Register this device's encryption key first");
      senderDeviceId = device.id;
      body = Buffer.from(input.encrypted.ciphertext, 'base64');
      if (body.length < 40 || body.length > MAX_CIPHERTEXT_BYTES) throw new BadRequestException('Invalid ciphertext');
      // Every current device of every member must get an envelope, so nobody is silently left out.
      const required = (await this.devicesWithKeys(input.conversationId)).map((d) => d.deviceId).sort();
      const provided = [...new Set(input.encrypted.keys.map((k) => k.deviceId))].sort();
      if (required.join() !== provided.join()) {
        throw new ConflictException({
          statusCode: 409,
          code: 'DEVICES_CHANGED',
          message: 'The devices in this conversation changed; encrypt again for the current list',
          devices: await this.devicesWithKeys(input.conversationId),
        });
      }
      encVersion = 1;
      if (input.attachmentId) await this.media.assertUsable(me, input.attachmentId, ['chat']);
    } else {
      if (input.encrypted) throw new BadRequestException('This conversation is not end-to-end encrypted');
      payload = normalisePayload(input.type, input.payload);
      if (input.type !== 'text') {
        await this.media.assertUsable(me, payload.mediaId!, ['chat']);
        const kind = (await this.media.resolve([payload.mediaId!])).get(payload.mediaId!)?.kind;
        if (kind !== input.type) throw new BadRequestException(`Media is a ${kind}, not ${input.type}`);
      }
      body = Buffer.from(JSON.stringify(payload), 'utf8');
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
        `INSERT INTO messages (conversation_id, sender_id, client_msg_id, type, payload, reply_to_id,
                               enc_version, sender_device_id, attachment_media_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (conversation_id, sender_id, client_msg_id) DO NOTHING
         RETURNING id`,
        [
          input.conversationId,
          me,
          input.clientMsgId,
          input.type,
          body,
          input.replyToId ?? null,
          encVersion,
          senderDeviceId,
          encVersion ? (input.attachmentId ?? null) : null,
        ],
      );
      let id: string;
      if (ins.rows[0]) {
        id = ins.rows[0].id;
        if (encVersion && input.encrypted) {
          await client.query(
            `INSERT INTO message_keys (message_id, device_id, box)
             SELECT $1, k.device_id, decode(k.box, 'base64')
               FROM unnest($2::uuid[], $3::text[]) AS k(device_id, box)`,
            [id, input.encrypted.keys.map((k) => k.deviceId), input.encrypted.keys.map((k) => k.box)],
          );
        }
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
        // Encrypted messages are unreadable here, so their push says only that something arrived.
        preview: encVersion
          ? 'New message'
          : input.type === 'text'
            ? (payload.text ?? '').slice(0, 100)
            : (label[input.type] ?? 'New message'),
      });
    }
    return { message, duplicate };
  }

  async history(me: string, conversationId: string, before?: string, limit = 30, deviceId: string | null = null) {
    await this.assertMember(me, conversationId);
    const r = await this.pg.query(
      `SELECT ${MSG_COLS}, ${STATUS_SQL} AS status
         FROM messages m
         JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1
        WHERE m.conversation_id = $2 AND ($3::bigint IS NULL OR m.id < $3)
          AND m.created_at >= cm.joined_at
          AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.user_id = $1 AND h.message_id = m.id)
        ORDER BY m.id DESC LIMIT $4`,
      [me, conversationId, before ?? null, Math.min(limit, 100)],
    );
    return this.toViews(me, r.rows, { deviceId });
  }

  /** Everything addressed to me after a cursor; clients call this after (re)connecting. */
  async sync(me: string, after: string, limit = 200, deviceId: string | null = null) {
    const r = await this.pg.query(
      `SELECT ${MSG_COLS}, ${STATUS_SQL} AS status
         FROM messages m
         JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1
        WHERE m.id > $2::bigint AND m.created_at >= cm.joined_at
          AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.user_id = $1 AND h.message_id = m.id)
        ORDER BY m.id ASC LIMIT $3`,
      [me, after, Math.min(limit, 500)],
    );
    return this.toViews(me, r.rows, { deviceId });
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
      `UPDATE messages SET deleted_at = now(), payload = $2, enc_version = 0, attachment_media_id = NULL
        WHERE id = $1 AND deleted_at IS NULL`,
      [messageId, Buffer.from('{}', 'utf8')],
    );
    await this.pg.query('DELETE FROM message_keys WHERE message_id = $1', [messageId]);
    this.realtime.emitToUsers(members, 'message:deleted', {
      messageId,
      conversationId: m.conversationId,
      scope: 'everyone',
    });
  }

  /**
   * Records a notice such as "Alice added Bob" in the conversation and pushes it to `audience`
   * (members plus, for removals, the person who just left so their app can show it).
   */
  async postSystem(
    conversationId: string,
    actorId: string,
    payload: Record<string, unknown>,
    audience: string[],
  ): Promise<MessageView> {
    const ins = await this.pg.query(
      `INSERT INTO messages (conversation_id, sender_id, client_msg_id, type, payload)
       VALUES ($1, $2, $3, 'system', $4) RETURNING id`,
      [conversationId, actorId, `sys-${randomUUID()}`, Buffer.from(JSON.stringify(payload), 'utf8')],
    );
    const id = ins.rows[0].id;
    await this.pg.query('UPDATE conversations SET last_message_id = $2, last_message_at = now() WHERE id = $1', [
      conversationId,
      id,
    ]);
    const row = (await this.pg.query(`SELECT ${MSG_COLS} FROM messages m WHERE m.id = $1`, [id])).rows[0];
    const [view] = await this.toViews(actorId, [row]);
    this.realtime.emitToUsers(audience, 'message:new', view);
    return view;
  }

  // ---- end-to-end encryption -------------------------------------------------------------------------

  /** Stores the public identity key that this session's device generated. A device key never changes. */
  async registerDeviceKey(sessionId: string, identityKey: string) {
    const device = await this.deviceOfSession(sessionId);
    if (!device) throw new BadRequestException('Unknown session');
    const key = Buffer.from(identityKey, 'base64');
    if (key.length !== 32) throw new BadRequestException('identityKey must be a 32-byte X25519 public key');
    const r = await this.pg.query(
      `UPDATE devices SET public_identity_key = $2 WHERE id = $1 AND public_identity_key IS NULL RETURNING id`,
      [device.id, key],
    );
    if (r.rowCount === 0) {
      const same = await this.pg.query('SELECT 1 FROM devices WHERE id = $1 AND public_identity_key = $2', [device.id, key]);
      if (same.rowCount === 0) {
        throw new ConflictException('This device already has a key; signing in again registers a new device');
      }
    }
    return { deviceId: device.id };
  }

  /** Current encryption-capable devices of every member: the recipients a sender must encrypt for. */
  async conversationDevices(me: string, conversationId: string) {
    await this.memberIds(conversationId, me);
    return this.devicesWithKeys(conversationId);
  }

  /** Identity keys of one user's current devices (for safety numbers). */
  async userDeviceKeys(me: string, userId: string) {
    const rel = (await this.friends.relationships(me, [userId])).get(userId);
    if (userId !== me && (rel === 'blocked' || rel === 'blocked_by')) throw new NotFoundException();
    const r = await this.pg.query(
      `SELECT d.id AS "deviceId", encode(d.public_identity_key, 'base64') AS "identityKey"
         FROM devices d
        WHERE d.user_id = $1 AND d.public_identity_key IS NOT NULL
          AND EXISTS (SELECT 1 FROM sessions s WHERE s.device_id = d.id AND s.revoked_at IS NULL AND s.expires_at > now())
        ORDER BY d.created_at`,
      [userId],
    );
    return r.rows as { deviceId: string; identityKey: string }[];
  }

  async deviceOfSession(sessionId: string): Promise<{ id: string; hasKey: boolean } | null> {
    const r = await this.pg.query(
      `SELECT d.id, d.public_identity_key IS NOT NULL AS "hasKey"
         FROM sessions s JOIN devices d ON d.id = s.device_id
        WHERE s.id = $1 AND s.revoked_at IS NULL`,
      [sessionId],
    );
    return r.rows[0] ?? null;
  }

  private async devicesWithKeys(conversationId: string) {
    const r = await this.pg.query(
      `SELECT d.id AS "deviceId", d.user_id AS "userId", encode(d.public_identity_key, 'base64') AS "identityKey"
         FROM conversation_members cm JOIN devices d ON d.user_id = cm.user_id
        WHERE cm.conversation_id = $1 AND d.public_identity_key IS NOT NULL
          AND EXISTS (SELECT 1 FROM sessions s WHERE s.device_id = d.id AND s.revoked_at IS NULL AND s.expires_at > now())
        ORDER BY d.id`,
      [conversationId],
    );
    return r.rows as { deviceId: string; userId: string; identityKey: string }[];
  }

  /** New conversations are encrypted when every member has at least one encryption-capable device. */
  async everyoneHasKeys(userIds: string[]): Promise<boolean> {
    if (process.env.E2E_ENABLED === 'false') return false;
    const r = await this.pg.query(
      `SELECT count(DISTINCT d.user_id)::int AS n FROM devices d
        WHERE d.user_id = ANY($1::uuid[]) AND d.public_identity_key IS NOT NULL
          AND EXISTS (SELECT 1 FROM sessions s WHERE s.device_id = d.id AND s.revoked_at IS NULL AND s.expires_at > now())`,
      [[...new Set(userIds)]],
    );
    return r.rows[0].n === new Set(userIds).size;
  }

  /** Member ids, throwing 404 when `me` is not one of them. */
  async membersOf(conversationId: string, me: string): Promise<string[]> {
    return this.memberIds(conversationId, me);
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

  private async toViews(me: string, rows: any[], scope: KeyScope = {}): Promise<MessageView[]> {
    const parsed = rows.map((row) => {
      let payload: any;
      if (row.deletedAt || row.encVersion !== 0) payload = {};
      else payload = JSON.parse((row.payload as Buffer).toString('utf8'));
      return { row, payload };
    });

    // Envelopes for encrypted messages, plus the sending devices' public keys so recipients can authenticate them.
    const enc = rows.filter((r) => r.encVersion === 1 && !r.deletedAt);
    const envelopes = new Map<string, Record<string, string>>();
    const senderKeys = new Map<string, string>();
    if (enc.length && scope.deviceId !== null) {
      const k = await this.pg.query(
        `SELECT message_id::text AS "messageId", device_id AS "deviceId", encode(box, 'base64') AS box
           FROM message_keys WHERE message_id = ANY($1::bigint[]) AND ($2::uuid IS NULL OR device_id = $2)`,
        [enc.map((r) => r.id), scope.deviceId ?? null],
      );
      for (const row of k.rows) {
        if (!envelopes.has(row.messageId)) envelopes.set(row.messageId, {});
        envelopes.get(row.messageId)![row.deviceId] = row.box;
      }
    }
    const senderDevices = [...new Set(enc.map((r) => r.senderDeviceId).filter(Boolean))];
    if (senderDevices.length) {
      const d = await this.pg.query(
        `SELECT id, encode(public_identity_key, 'base64') AS key FROM devices WHERE id = ANY($1::uuid[])`,
        [senderDevices],
      );
      for (const row of d.rows) senderKeys.set(row.id, row.key);
    }

    const mediaIds = [
      ...(parsed.map((p) => p.payload.mediaId).filter(Boolean) as string[]),
      ...(rows.map((r) => r.attachmentId).filter(Boolean) as string[]),
    ];
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
      media: payload.mediaId ? media.get(payload.mediaId) : row.attachmentId ? media.get(row.attachmentId) : undefined,
      ...(row.encVersion === 1 && !row.deletedAt
        ? {
            encrypted: {
              version: row.encVersion,
              ciphertext: (row.payload as Buffer).toString('base64'),
              senderDeviceId: row.senderDeviceId,
              senderKey: senderKeys.get(row.senderDeviceId) ?? null,
              keys: envelopes.get(String(row.id)) ?? {},
            },
          }
        : {}),
    }));
  }
}
