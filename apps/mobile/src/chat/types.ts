import { t } from '../i18n';

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
  payload: {
    text?: string;
    mediaId?: string;
    caption?: string;
    storyId?: string;
    /** encrypted attachments: decryption key, nonce and real type travel inside the encrypted payload */
    fileKey?: string;
    fileNonce?: string;
    mime?: string;
  } & Partial<SystemPayload>;
  replyToId: string | null;
  createdAt: string;
  deleted: boolean;
  status?: 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
  media?: ChatMedia;
  /** End-to-end encrypted messages as delivered by the server; decrypted on the phone into `payload`. */
  encrypted?: {
    version: number;
    ciphertext: string;
    senderDeviceId: string | null;
    senderKey: string | null;
    keys: Record<string, string>;
  };
  /** Encrypted, but this device holds no key for it (it was sent before you signed in here). */
  undecryptable?: boolean;
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
  /** End-to-end encrypted: the server cannot read messages in this conversation. */
  e2e: boolean;
  avatarUrl: string | null;
  myRole: 'admin' | 'member';
  mutedUntil: string | null;
  unread: number;
  lastMessageAt: string | null;
  lastMessage: ChatMessage | null;
  members: ChatMember[];
}

export const memberName = (m?: Pick<ChatMember, 'displayName' | 'username'> | null) =>
  m?.displayName ?? m?.username ?? t('Someone');

export function conversationTitle(c: Conversation, meId: string) {
  if (c.type === 'group') return c.title ?? t('Group');
  const other = c.members.find((m) => m.id !== meId);
  return other ? memberName(other) : t('Deleted account');
}

export const isMuted = (c: Pick<Conversation, 'mutedUntil'>) => !!c.mutedUntil && new Date(c.mutedUntil) > new Date();

/** Human text for a system notice. `names` maps user ids to display names (people who left may be missing). */
export function describeSystem(m: ChatMessage, names: Map<string, string>, meId: string) {
  const who = (id?: string) => (id === meId ? t('You') : (id && names.get(id)) || t('Someone'));
  const actor = who(m.senderId);
  const p = m.payload;
  switch (p.event) {
    case 'members_added':
      return t('{actor} added {people}', { actor, people: (p.userIds ?? []).map(who).join(', ') });
    case 'member_removed':
      return t('{actor} removed {person}', { actor, person: who(p.userId) });
    case 'member_left':
      return t('{person} left', { person: who(p.userId) });
    case 'admin_added':
      return t('{actor} made {person} an admin', { actor, person: who(p.userId) });
    case 'admin_removed':
      return t('{actor} removed {person} as admin', { actor, person: who(p.userId) });
    case 'renamed':
      return t('{actor} renamed the group to "{title}"', { actor, title: p.title ?? '' });
    case 'photo_changed':
      return t('{actor} changed the group photo', { actor });
    default:
      return '';
  }
}

export function previewOf(m: ChatMessage | null, names?: Map<string, string>, meId?: string) {
  if (!m) return t('No messages yet');
  if (m.deleted) return t('This message was deleted');
  if (m.encrypted) return t('🔒 Message');
  if (m.type === 'system') return names && meId ? describeSystem(m, names, meId) : t('Group updated');
  if (m.type === 'text') return m.payload.text ?? '';
  return t({ image: 'Photo', video: 'Video', audio: 'Voice message', file: 'File' }[m.type]);
}
