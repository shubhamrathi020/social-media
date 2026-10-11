import { BadRequestException } from '@nestjs/common';

export type MediaKind = 'image' | 'video' | 'audio' | 'file';
export type MediaPurpose = 'avatar' | 'post' | 'story' | 'status' | 'chat';

const MB = 1024 * 1024;

export const MIME_BY_KIND: Record<MediaKind, string[]> = {
  image: ['image/jpeg', 'image/png', 'image/webp'],
  video: ['video/mp4', 'video/quicktime', 'video/webm'],
  audio: ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/webm'],
  // application/octet-stream: attachments encrypted on the device for end-to-end encrypted chats (chat only).
  file: ['application/pdf', 'application/zip', 'text/plain', 'application/octet-stream'],
};

export const MAX_BYTES: Record<MediaKind, number> = {
  image: 15 * MB,
  video: 150 * MB,
  audio: 20 * MB,
  file: 25 * MB,
};

export const MAX_VIDEO_SECONDS = 300;

/** Which kinds each purpose accepts. */
const ALLOWED: Record<MediaPurpose, MediaKind[]> = {
  avatar: ['image'],
  post: ['image', 'video'],
  story: ['image', 'video'],
  status: ['image', 'video'],
  chat: ['image', 'video', 'audio', 'file'],
};

export function validateUploadRequest(kind: MediaKind, purpose: MediaPurpose, mime: string, sizeBytes: number) {
  if (!ALLOWED[purpose].includes(kind)) {
    throw new BadRequestException(`${kind} is not allowed for ${purpose}`);
  }
  if (!MIME_BY_KIND[kind].includes(mime)) {
    throw new BadRequestException(`Unsupported ${kind} type ${mime}`);
  }
  if (sizeBytes <= 0 || sizeBytes > MAX_BYTES[kind]) {
    throw new BadRequestException(`${kind} must be at most ${MAX_BYTES[kind] / MB} MB`);
  }
}
