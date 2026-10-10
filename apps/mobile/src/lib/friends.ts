import { api, json } from './api';

export type Relationship =
  | 'self'
  | 'none'
  | 'friends'
  | 'request_sent'
  | 'request_received'
  | 'blocked'
  | 'blocked_by';

export interface UserSummary {
  id: string;
  username: string | null;
  displayName: string | null;
  avatarMediaId: string | null;
}
export interface Friend extends UserSummary {
  friendsSince: string;
  isCloseFriend: boolean;
}
export interface FriendRequest {
  id: string;
  createdAt: string;
  user: UserSummary;
}
export interface Suggestion extends UserSummary {
  mutualCount: number;
  reason: 'mutual' | 'contact';
}
export interface SearchResult extends UserSummary {
  relationship: Relationship;
}

export const friendsApi = {
  friends: () => api<Friend[]>('/friends'),
  incoming: () => api<FriendRequest[]>('/friends/requests?direction=in'),
  outgoing: () => api<FriendRequest[]>('/friends/requests?direction=out'),
  suggestions: () => api<Suggestion[]>('/friends/suggestions'),
  search: (q: string) => api<SearchResult[]>(`/users/search?q=${encodeURIComponent(q)}`),

  sendRequest: (toUser: string) => api('/friends/requests', json({ toUser })),
  accept: (id: string) => api(`/friends/requests/${id}/accept`, { method: 'POST' }),
  decline: (id: string) => api(`/friends/requests/${id}/decline`, { method: 'POST' }),
  cancel: (id: string) => api(`/friends/requests/${id}/cancel`, { method: 'POST' }),
  unfriend: (id: string) => api(`/friends/${id}`, { method: 'DELETE' }),
  dismiss: (id: string) => api(`/friends/suggestions/${id}/dismiss`, { method: 'POST' }),
  addCloseFriend: (id: string) => api(`/close-friends/${id}`, { method: 'PUT' }),
  removeCloseFriend: (id: string) => api(`/close-friends/${id}`, { method: 'DELETE' }),
  block: (id: string) => api(`/blocks/${id}`, { method: 'PUT' }),
};

export const nameOf = (u: UserSummary) => u.displayName ?? u.username ?? 'Unknown';
