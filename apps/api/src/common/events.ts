/**
 * In-process domain events. Modules announce what happened; other modules (notifications today, maybe
 * analytics or search later) react without the emitter knowing about them.
 */
export const Events = {
  FriendRequest: 'friend.request',
  FriendAccepted: 'friend.accepted',
  PostLiked: 'post.liked',
  CommentCreated: 'comment.created',
  LiveStarted: 'live.started',
  MessageCreated: 'message.created',
} as const;

export interface FriendRequestEvent {
  fromUserId: string;
  toUserId: string;
  requestId: string;
}
export interface FriendAcceptedEvent {
  accepterId: string;
  requesterId: string;
}
export interface PostLikedEvent {
  postId: string;
  authorId: string;
  actorId: string;
}
export interface CommentCreatedEvent {
  postId: string;
  commentId: string;
  postAuthorId: string;
  actorId: string;
  /** Author of the comment being replied to, when this is a reply. */
  parentAuthorId: string | null;
  preview: string;
}
export interface LiveStartedEvent {
  liveId: string;
  hostId: string;
  title: string;
  audienceIds: string[];
}
export interface MessageCreatedEvent {
  conversationId: string;
  messageId: string;
  senderId: string;
  recipientIds: string[];
  type: string;
  preview: string;
}
