import { BadRequestException } from '@nestjs/common';

export type MessageType = 'text' | 'image' | 'video' | 'audio' | 'file';

export const MAX_TEXT_LENGTH = 4000;

/** Key that identifies the single direct conversation between two users. */
export const directKey = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`);

export interface MessagePayload {
  text?: string;
  mediaId?: string;
  caption?: string;
  /** Set when a text message is a reply to a story. */
  storyId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validates and normalises what a client may put in a message body. */
export function normalisePayload(type: MessageType, raw: unknown): MessagePayload {
  const p = (raw ?? {}) as Record<string, unknown>;
  if (type === 'text') {
    const text = typeof p.text === 'string' ? p.text.trim() : '';
    if (!text) throw new BadRequestException('Message text is empty');
    if (text.length > MAX_TEXT_LENGTH) throw new BadRequestException(`Message is longer than ${MAX_TEXT_LENGTH}`);
    const out: MessagePayload = { text };
    if (typeof p.storyId === 'string' && UUID.test(p.storyId)) out.storyId = p.storyId;
    return out;
  }
  if (typeof p.mediaId !== 'string' || !UUID.test(p.mediaId)) {
    throw new BadRequestException('mediaId is required for media messages');
  }
  const out: MessagePayload = { mediaId: p.mediaId };
  if (typeof p.caption === 'string' && p.caption.trim()) {
    if (p.caption.length > 1000) throw new BadRequestException('Caption is too long');
    out.caption = p.caption.trim();
  }
  return out;
}
