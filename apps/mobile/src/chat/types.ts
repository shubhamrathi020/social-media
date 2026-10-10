export interface ChatMedia {
  id: string;
  kind: 'image' | 'video' | 'audio' | 'file';
  url?: string;
  thumbUrl?: string;
  width: number | null;
  height: number | null;
}

/** Payload of a system notice ("Ann added Dan"). */
export interface SystemPayload {
  event:
    | 'members_added'
    | 'member_removed'
    | 'member_left'
    | 'admin_added'
    | 'admin_removed'
    | 'renamed'
    | 'photo_changed';
  userIds?: string[];
  userId?: string;
  title?: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  clientMsgId: string;
  type: 'text' | 'image' | 'video' | 'audio' | 'file' | 'system';
  payload: { text?: string; mediaId?: string; caption?: string; storyId?: string } & Partial<SystemPayload>;
  replyToId: string | null;
  createdAt: string;
  deleted: boolean;
  status?: 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
  media?: ChatMedia;
}

export interface ChatMember {
  id: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  role: 'admin' | 'member';
}

export interface Conversation {
  id: string;
  type: 'direct' | 'group';
  title: string | null;
  avatarUrl: string | null;
  myRole: 'admin' | 'member';
  mutedUntil: string | null;
  unread: number;
  lastMessageAt: string | null;
  lastMessage: ChatMessage | null;
  members: ChatMember[];
}

export const memberName = (m?: Pick<ChatMember, 'displayName' | 'username'> | null) =>
  m?.displayName ?? m?.username ?? 'Someone';

export function conversationTitle(c: Conversation, meId: string) {
  if (c.type === 'group') return c.title ?? 'Group';
  const other = c.members.find((m) => m.id !== meId);
  return other ? memberName(other) : 'Deleted account';
}

export const isMuted = (c: Pick<Conversation, 'mutedUntil'>) => !!c.mutedUntil && new Date(c.mutedUntil) > new Date();

/** Human text for a system notice. `names` maps user ids to display names (people who left may be missing). */
export function describeSystem(m: ChatMessage, names: Map<string, string>, meId: string) {
  const who = (id?: string) => (id === meId ? 'You' : (id && names.get(id)) || 'Someone');
  const actor = who(m.senderId);
  const p = m.payload;
  switch (p.event) {
    case 'members_added':
      return `${actor} added ${(p.userIds ?? []).map(who).join(', ')}`;
    case 'member_removed':
      return `${actor} removed ${who(p.userId)}`;
    case 'member_left':
      return `${who(p.userId)} left`;
    case 'admin_added':
      return `${actor} made ${who(p.userId)} an admin`;
    case 'admin_removed':
      return `${actor} removed ${who(p.userId)} as admin`;
    case 'renamed':
      return `${actor} renamed the group to "${p.title ?? ''}"`;
    case 'photo_changed':
      return `${actor} changed the group photo`;
    default:
      return '';
  }
}

export function previewOf(m: ChatMessage | null, names?: Map<string, string>, meId?: string) {
  if (!m) return 'No messages yet';
  if (m.deleted) return 'This message was deleted';
  if (m.type === 'system') return names && meId ? describeSystem(m, names, meId) : 'Group updated';
  if (m.type === 'text') return m.payload.text ?? '';
  return { image: 'Photo', video: 'Video', audio: 'Voice message', file: 'File' }[m.type];
}
