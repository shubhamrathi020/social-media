import { Conversation } from '../chat/types';
import { api, json } from './api';

const patch = (body: unknown): RequestInit => ({ method: 'PATCH', body: JSON.stringify(body) });

export const groupsApi = {
  get: (id: string) => api<Conversation[]>('/conversations').then((all) => all.find((c) => c.id === id) ?? null),
  create: (title: string, memberIds: string[]) => api<Conversation>('/conversations', json({ title, memberIds })),
  rename: (id: string, title: string) => api<Conversation>(`/conversations/${id}`, patch({ title })),
  setPhoto: (id: string, avatarMediaId: string | null) => api<Conversation>(`/conversations/${id}`, patch({ avatarMediaId })),
  addMembers: (id: string, userIds: string[]) => api<Conversation>(`/conversations/${id}/members`, json({ userIds })),
  remove: (id: string, userId: string) => api(`/conversations/${id}/members/${userId}`, { method: 'DELETE' }),
  setRole: (id: string, userId: string, role: 'admin' | 'member') =>
    api<Conversation>(`/conversations/${id}/members/${userId}`, patch({ role })),
  leave: (id: string) => api<{ deleted: boolean }>(`/conversations/${id}/leave`, { method: 'POST' }),
  mute: (id: string, mutedUntil: string | null) =>
    api<{ mutedUntil: string | null }>(`/conversations/${id}/mute`, { method: 'PUT', body: JSON.stringify({ mutedUntil }) }),
};
