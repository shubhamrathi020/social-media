import { api, json } from './api';

export type StoryKind = 'story' | 'status';

export interface StoryItem {
  id: string;
  kind: StoryKind;
  media: {
    id: string;
    kind: 'image' | 'video';
    url?: string;
    thumbUrl?: string;
    durationMs: number | null;
  } | null;
  text: string | null;
  background: string | null;
  audience: 'friends' | 'close_friends';
  createdAt: string;
  expiresAt: string;
  seen: boolean;
  viewCount?: number;
}

export interface StoryGroup {
  author: { id: string; username: string | null; displayName: string | null; avatarUrl: string | null };
  hasUnseen: boolean;
  isMe: boolean;
  items: StoryItem[];
}

export const storiesApi = {
  feed: (kind: StoryKind) => api<StoryGroup[]>(kind === 'story' ? '/stories/feed' : '/statuses/feed'),
  createStory: (body: { mediaId: string; text?: string; audience: 'friends' | 'close_friends' }) =>
    api<StoryItem>('/stories', json(body)),
  createStatus: (body: { text?: string; background?: string; mediaId?: string; audience?: 'friends' | 'close_friends' }) =>
    api<StoryItem>('/statuses', json(body)),
  view: (id: string) => api(`/stories/${id}/view`, { method: 'POST' }),
  remove: (id: string) => api(`/stories/${id}`, { method: 'DELETE' }),
  reply: (id: string, text: string) => api(`/stories/${id}/reply`, json({ text })),
  viewers: (id: string) =>
    api<{ id: string; username: string | null; displayName: string | null; viewedAt: string }[]>(
      `/stories/${id}/viewers`,
    ),
};
