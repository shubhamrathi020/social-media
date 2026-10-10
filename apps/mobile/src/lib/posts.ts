import { api, json } from './api';

export interface Author {
  id: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface Slide {
  position: number;
  media: {
    id: string;
    kind: 'image' | 'video';
    url?: string;
    thumbUrl?: string;
    width: number | null;
    height: number | null;
    durationMs: number | null;
  } | null;
}

export type Reaction = 1 | -1 | null;
export type Audience = 'public' | 'friends' | 'close_friends';

export interface Post {
  id: string;
  author: Author;
  caption: string;
  audience: Audience;
  slides: Slide[];
  likeCount: number;
  dislikeCount?: number;
  commentCount: number;
  myReaction: Reaction;
  createdAt: string;
}

export interface Comment {
  id: string;
  postId: string;
  parentId: string | null;
  author: Author;
  body: string;
  deleted: boolean;
  likeCount: number;
  replyCount: number;
  myReaction: Reaction;
  createdAt: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

const qs = (o: Record<string, string | undefined | null>) => {
  const p = Object.entries(o).filter(([, v]) => v != null && v !== '') as [string, string][];
  return p.length ? '?' + p.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&') : '';
};

export const postsApi = {
  feed: (cursor?: string | null) => api<Page<Post>>(`/feed${qs({ cursor })}`),
  byAuthor: (userId: string, cursor?: string | null) =>
    api<Page<Post>>(`/users/${userId}/posts${qs({ cursor })}`),
  get: (id: string) => api<Post>(`/posts/${id}`),
  create: (body: { caption?: string; audience: Audience; mediaIds: string[] }) =>
    api<Post>('/posts', json(body)),
  remove: (id: string) => api(`/posts/${id}`, { method: 'DELETE' }),
  react: (id: string, value: Reaction) =>
    value === null
      ? api<{ likeCount: number; commentCount: number; dislikeCount?: number }>(`/posts/${id}/reaction`, { method: 'DELETE' })
      : api<{ likeCount: number; commentCount: number; dislikeCount?: number }>(`/posts/${id}/reaction`, {
          method: 'PUT',
          body: JSON.stringify({ value }),
        }),
  comments: (postId: string, cursor?: string | null, parentId?: string) =>
    api<Page<Comment>>(`/posts/${postId}/comments${qs({ cursor, parentId })}`),
  addComment: (postId: string, body: string, parentId?: string) =>
    api<Comment>(`/posts/${postId}/comments`, json({ body, parentId })),
  removeComment: (id: string) => api(`/comments/${id}`, { method: 'DELETE' }),
  reactComment: (id: string, value: Reaction) =>
    value === null
      ? api<{ likeCount: number }>(`/comments/${id}/reaction`, { method: 'DELETE' })
      : api<{ likeCount: number }>(`/comments/${id}/reaction`, { method: 'PUT', body: JSON.stringify({ value }) }),
};
