export interface ChatMedia {
  id: string;
  kind: 'image' | 'video' | 'audio' | 'file';
  url?: string;
  thumbUrl?: string;
  width: number | null;
  height: number | null;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  clientMsgId: string;
  type: 'text' | 'image' | 'video' | 'audio' | 'file' | 'system';
  payload: { text?: string; mediaId?: string; caption?: string };
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
}

export interface Conversation {
  id: string;
  type: 'direct' | 'group';
  title: string | null;
  unread: number;
  lastMessageAt: string | null;
  lastMessage: ChatMessage | null;
  members: ChatMember[];
}

export function conversationTitle(c: Conversation, meId: string) {
  if (c.type === 'group') return c.title ?? 'Group';
  const other = c.members.find((m) => m.id !== meId);
  return other?.displayName ?? other?.username ?? 'Unknown';
}

export function previewOf(m: ChatMessage | null) {
  if (!m) return 'No messages yet';
  if (m.deleted) return 'This message was deleted';
  if (m.type === 'text') return m.payload.text ?? '';
  return { image: 'Photo', video: 'Video', audio: 'Voice message', file: 'File', system: '' }[m.type];
}
