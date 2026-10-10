import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../../common/infra.module';
import { FriendsService } from '../friends/friends.service';
import { MediaService } from '../media/media.service';
import { RealtimeService } from '../realtime/realtime.service';
import { ChatService } from './chat.service';

export const MAX_GROUP_MEMBERS = 256;

interface Member {
  userId: string;
  role: 'admin' | 'member';
  joinedAt: string;
}

/**
 * Group administration. Rules:
 * - admins add and remove people, rename the group, change its picture and promote/demote others
 * - you may only add your own friends (the same rule as creating a group)
 * - anyone may leave; a group always keeps at least one admin (the longest-standing member is promoted)
 * - when the last person leaves the group is deleted
 * - people who join later do not see older messages; people who leave lose access to the history
 */
@Injectable()
export class GroupsService {
  constructor(
    @Inject(PG_POOL) private readonly pg: Pool,
    private readonly chat: ChatService,
    private readonly friends: FriendsService,
    private readonly media: MediaService,
    private readonly realtime: RealtimeService,
  ) {}

  async update(me: string, id: string, patch: { title?: string; avatarMediaId?: string | null }) {
    const members = await this.loadGroup(id, me);
    this.assertAdmin(members, me);

    if (patch.avatarMediaId) await this.media.assertUsable(me, patch.avatarMediaId, ['avatar', 'chat']);
    const title = patch.title?.trim();
    if (patch.title !== undefined && !title) throw new BadRequestException('Title cannot be empty');

    await this.pg.query(
      `UPDATE conversations
          SET title = COALESCE($2, title),
              avatar_media_id = CASE WHEN $3::boolean THEN $4::uuid ELSE avatar_media_id END
        WHERE id = $1`,
      [id, title ?? null, patch.avatarMediaId !== undefined, patch.avatarMediaId ?? null],
    );
    const ids = members.map((m) => m.userId);
    if (title) await this.chat.postSystem(id, me, { event: 'renamed', title }, ids);
    if (patch.avatarMediaId !== undefined) await this.chat.postSystem(id, me, { event: 'photo_changed' }, ids);
    this.realtime.emitToUsers(ids, 'conversation:updated', { conversationId: id });
    return this.chat.getConversation(me, id);
  }

  async addMembers(me: string, id: string, userIds: string[]) {
    const members = await this.loadGroup(id, me);
    this.assertAdmin(members, me);

    const current = new Set(members.map((m) => m.userId));
    const toAdd = [...new Set(userIds)].filter((u) => !current.has(u));
    if (toAdd.length === 0) throw new BadRequestException('Everyone is already in the group');
    if (current.size + toAdd.length > MAX_GROUP_MEMBERS) {
      throw new BadRequestException(`A group can have at most ${MAX_GROUP_MEMBERS} people`);
    }
    const rels = await this.friends.relationships(me, toAdd);
    for (const u of toAdd) {
      if (rels.get(u) !== 'friends') throw new BadRequestException('You can only add your friends');
    }

    await this.pg.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role)
       SELECT $1, u, 'member' FROM unnest($2::uuid[]) AS u ON CONFLICT DO NOTHING`,
      [id, toAdd],
    );
    const all = [...current, ...toAdd];
    await this.chat.postSystem(id, me, { event: 'members_added', userIds: toAdd }, all);
    this.realtime.emitToUsers(toAdd, 'conversation:new', { conversationId: id });
    this.realtime.emitToUsers([...current], 'conversation:updated', { conversationId: id });
    return this.chat.getConversation(me, id);
  }

  /** Removing yourself is leaving. Removing someone else needs admin rights. */
  async removeMember(me: string, id: string, userId: string) {
    const members = await this.loadGroup(id, me);
    const target = members.find((m) => m.userId === userId);
    if (!target) throw new NotFoundException('That person is not in the group');
    const leaving = userId === me;
    if (!leaving) this.assertAdmin(members, me);

    const remaining = members.filter((m) => m.userId !== userId);
    await this.tx(async (c) => {
      await c.query('DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [id, userId]);
      if (remaining.length === 0) {
        await c.query('DELETE FROM conversations WHERE id = $1', [id]);
        return;
      }
      if (!remaining.some((m) => m.role === 'admin')) {
        const heir = [...remaining].sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))[0];
        await c.query(
          `UPDATE conversation_members SET role = 'admin' WHERE conversation_id = $1 AND user_id = $2`,
          [id, heir.userId],
        );
        heir.role = 'admin';
      }
    });

    this.realtime.emitToUsers([userId], 'conversation:removed', { conversationId: id });
    if (remaining.length === 0) return { deleted: true };

    const ids = remaining.map((m) => m.userId);
    await this.chat.postSystem(
      id,
      me,
      leaving ? { event: 'member_left', userId } : { event: 'member_removed', userId },
      ids,
    );
    this.realtime.emitToUsers(ids, 'conversation:updated', { conversationId: id });
    return { deleted: false };
  }

  async setRole(me: string, id: string, userId: string, role: 'admin' | 'member') {
    const members = await this.loadGroup(id, me);
    this.assertAdmin(members, me);
    const target = members.find((m) => m.userId === userId);
    if (!target) throw new NotFoundException('That person is not in the group');
    if (target.role === role) return this.chat.getConversation(me, id);
    if (role === 'member' && members.filter((m) => m.role === 'admin').length === 1) {
      throw new ConflictException('A group needs at least one admin');
    }
    await this.pg.query('UPDATE conversation_members SET role = $3 WHERE conversation_id = $1 AND user_id = $2', [
      id,
      userId,
      role,
    ]);
    const ids = members.map((m) => m.userId);
    await this.chat.postSystem(id, me, { event: role === 'admin' ? 'admin_added' : 'admin_removed', userId }, ids);
    this.realtime.emitToUsers(ids, 'conversation:updated', { conversationId: id });
    return this.chat.getConversation(me, id);
  }

  /** Works for direct chats too. `until` null unmutes. */
  async mute(me: string, id: string, until: Date | null) {
    await this.chat.membersOf(id, me);
    if (until && until.getTime() < Date.now()) throw new BadRequestException('mutedUntil must be in the future');
    await this.pg.query(
      'UPDATE conversation_members SET muted_until = $3 WHERE conversation_id = $1 AND user_id = $2',
      [id, me, until],
    );
    return { mutedUntil: until?.toISOString() ?? null };
  }

  // ---- helpers ---------------------------------------------------------------------------------

  private async loadGroup(id: string, me: string): Promise<Member[]> {
    const r = await this.pg.query(
      `SELECT c.type, cm.user_id AS "userId", cm.role, cm.joined_at AS "joinedAt"
         FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id
        WHERE c.id = $1`,
      [id],
    );
    if (!r.rows.some((m) => m.userId === me)) throw new NotFoundException('Conversation not found');
    if (r.rows[0].type !== 'group') throw new BadRequestException('Only groups have members to manage');
    return r.rows.map((m) => ({ ...m, joinedAt: new Date(m.joinedAt).toISOString() }));
  }

  private assertAdmin(members: Member[], me: string) {
    if (members.find((m) => m.userId === me)?.role !== 'admin') {
      throw new ForbiddenException('Only group admins can do that');
    }
  }

  private async tx(fn: (c: PoolClient) => Promise<void>) {
    const c = await this.pg.connect();
    try {
      await c.query('BEGIN');
      await fn(c);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }
}
