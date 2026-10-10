import { api, json } from './api';

export interface LiveStream {
  id: string;
  title: string;
  audience: 'friends' | 'close_friends';
  status: 'created' | 'live' | 'ended';
  host: { id: string; username: string | null; displayName: string | null; avatarUrl: string | null };
  viewerCount: number;
  heartCount: number;
  startedAt: string | null;
}

export interface LiveChatMessage {
  id: string;
  liveId: string;
  text: string;
  at: string;
  author: { id: string; username: string | null; displayName: string | null; avatarUrl: string | null };
}

export interface LiveJoin {
  stream: LiveStream;
  url: string;
  token: string;
  recentChat: LiveChatMessage[];
}

export const liveApi = {
  create: (title: string, audience: 'friends' | 'close_friends') =>
    api<{ id: string; room: string; url: string; token: string }>('/live', json({ title, audience })),
  start: (id: string) => api<LiveStream>(`/live/${id}/start`, { method: 'POST' }),
  end: (id: string) => api(`/live/${id}/end`, { method: 'POST' }),
  join: (id: string) => api<LiveJoin>(`/live/${id}/join`, { method: 'POST' }),
  liveNow: () => api<LiveStream[]>('/live'),
};
