import * as ImagePicker from 'expo-image-picker';
import { api, json } from './api';

export type MediaPurpose = 'avatar' | 'post' | 'story' | 'status' | 'chat';

export interface Media {
  id: string;
  kind: 'image' | 'video' | 'audio' | 'file';
  status: 'uploading' | 'processing' | 'ready' | 'failed';
  width: number | null;
  height: number | null;
  durationMs: number | null;
  url?: string;
  thumbUrl?: string;
  error?: string | null;
}

interface UploadTicket {
  id: string;
  upload: { method: 'PUT'; url: string; headers: Record<string, string>; expiresIn: number };
}

/** PUT with progress (fetch cannot report upload progress on React Native). */
function putWithProgress(url: string, headers: Record<string, string>, blob: Blob, onProgress?: (p: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`)));
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.send(blob);
  });
}

async function waitUntilProcessed(id: string, timeoutMs = 120_000): Promise<Media> {
  const start = Date.now();
  let delay = 400;
  while (Date.now() - start < timeoutMs) {
    const m = await api<Media>(`/media/${id}`);
    if (m.status === 'ready') return m;
    if (m.status === 'failed') throw new Error(m.error ?? 'Media processing failed');
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 3000);
  }
  throw new Error('Timed out while processing media');
}

export interface PickedFile {
  uri: string;
  kind: 'image' | 'video';
  mime: string;
}

export async function pickFromLibrary(kinds: ('image' | 'video')[] = ['image']): Promise<PickedFile | null> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) throw new Error('Photo library permission is required');
  const res = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: kinds.length === 2 ? ['images', 'videos'] : kinds[0] === 'image' ? ['images'] : ['videos'],
    quality: 0.9,
    allowsEditing: false,
  });
  if (res.canceled || !res.assets[0]) return null;
  const a = res.assets[0];
  const isVideo = a.type === 'video';
  return { uri: a.uri, kind: isVideo ? 'video' : 'image', mime: a.mimeType ?? (isVideo ? 'video/mp4' : 'image/jpeg') };
}

/** Full flow: request ticket, PUT to storage, tell the API, wait for processing. */
export async function uploadMedia(
  file: PickedFile,
  purpose: MediaPurpose,
  onProgress?: (p: number) => void,
): Promise<Media> {
  const blob = await (await fetch(file.uri)).blob();
  const ticket = await api<UploadTicket>(
    '/media/uploads',
    json({ kind: file.kind, purpose, mime: file.mime, sizeBytes: blob.size }),
  );
  await putWithProgress(ticket.upload.url, ticket.upload.headers, blob, onProgress);
  await api(`/media/${ticket.id}/complete`, { method: 'POST' });
  return waitUntilProcessed(ticket.id);
}

/** Multi-select picker for post slides (images and/or videos), capped at `max`. */
export async function pickMany(max: number): Promise<PickedFile[]> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) throw new Error('Photo library permission is required');
  const res = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images', 'videos'],
    allowsMultipleSelection: true,
    selectionLimit: max,
    quality: 0.9,
  });
  if (res.canceled) return [];
  return res.assets.slice(0, max).map((a) => {
    const isVideo = a.type === 'video';
    return {
      uri: a.uri,
      kind: isVideo ? 'video' : 'image',
      mime: a.mimeType ?? (isVideo ? 'video/mp4' : 'image/jpeg'),
    } as PickedFile;
  });
}
