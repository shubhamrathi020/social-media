import { api } from './api';

export type Audience = 'everyone' | 'friends' | 'nobody';

export interface Settings {
  privacy: { messages: Audience; lastSeen: Audience; stories: Audience };
  notifications: { messages: boolean; friendRequests: boolean; likes: boolean; comments: boolean; live: boolean };
  media: { dataSaver: boolean; autoplay: boolean };
  language: string;
  theme: 'light' | 'dark' | 'system';
}

export type SettingsPatch = {
  privacy?: Partial<Settings['privacy']>;
  notifications?: Partial<Settings['notifications']>;
  media?: Partial<Settings['media']>;
  language?: string;
  theme?: Settings['theme'];
};

export interface SessionInfo {
  id: string;
  platform: string;
  createdAt: string;
  lastUsedAt: string;
  current: boolean;
}

export interface Notification {
  id: string;
  type: 'friend_request' | 'friend_accepted' | 'post_liked' | 'comment' | 'comment_reply' | 'live_started';
  actor: { id: string; username: string | null; displayName: string | null; avatarUrl: string | null } | null;
  entityType: string | null;
  entityId: string | null;
  data: { preview?: string; title?: string };
  readAt: string | null;
  createdAt: string;
}

export const settingsApi = {
  get: () => api<Settings>('/settings'),
  update: (patch: SettingsPatch) => api<Settings>('/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
  sessions: () => api<SessionInfo[]>('/auth/sessions'),
  revokeSession: (id: string) => api(`/auth/sessions/${id}`, { method: 'DELETE' }),
  blocked: () =>
    api<{ id: string; username: string | null; displayName: string | null; avatarUrl: string | null }[]>('/blocks'),
  unblock: (id: string) => api(`/blocks/${id}`, { method: 'DELETE' }),
  deleteAccount: () => api('/users/me', { method: 'DELETE' }),
};

export const notificationsApi = {
  list: (cursor?: string | null) =>
    api<{ items: Notification[]; nextCursor: string | null }>(`/notifications${cursor ? `?cursor=${cursor}` : ''}`),
  unread: () => api<{ unread: number }>('/notifications/unread-count'),
  markAllRead: () => api<{ unread: number }>('/notifications/read', { method: 'POST', body: JSON.stringify({}) }),
  registerPushToken: (pushToken: string | null) =>
    api('/devices/me', { method: 'PUT', body: JSON.stringify({ pushToken }) }),
};
