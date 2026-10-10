export const MAX_POST_SLIDES = 5;

export type FriendRequestStatus = 'pending' | 'accepted' | 'declined' | 'cancelled';
export type Audience = 'public' | 'friends' | 'close_friends';
export type StoryAudience = 'friends' | 'close_friends';

/** Socket.IO event names shared by API and mobile. See docs/API_AND_REALTIME_EVENTS.md */
export const SocketEvents = {
  MessageSend: 'message:send',
  MessageNew: 'message:new',
  MessageStatus: 'message:status',
  Typing: 'typing',
  PostLike: 'post:like',
  PostUnlike: 'post:unlike',
  PostCounters: 'post:counters',
  Presence: 'presence',
} as const;
