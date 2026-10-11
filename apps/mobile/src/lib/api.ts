import { storage } from './storage';
import { API_URL } from './config';

const REFRESH_KEY = 'refreshToken';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Parsed JSON error body, e.g. { code: 'E2E_CONVERSATION', conversationId } */
    public body: Record<string, unknown> | null = null,
  ) {
    super(message);
  }
}

let accessToken: string | null = null;
let onSignedOut: (() => void) | null = null;
let refreshing: Promise<boolean> | null = null;

export const tokens = {
  setAccess: (t: string | null) => {
    accessToken = t;
  },
  getAccess: () => accessToken,
  getRefresh: () => storage.get(REFRESH_KEY),
  setRefresh: (t: string) => storage.set(REFRESH_KEY, t),
  clear: async () => {
    accessToken = null;
    await storage.remove(REFRESH_KEY);
  },
  onSignedOut: (fn: () => void) => {
    onSignedOut = fn;
  },
};

async function raw(path: string, init: RequestInit = {}, auth = true) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth && accessToken) headers.authorization = `Bearer ${accessToken}`;
  return fetch(`${API_URL}${path}`, { ...init, headers: { ...headers, ...(init.headers as object) } });
}

/** Single-flight refresh so parallel 401s don't rotate the token twice (which would trip reuse detection). */
function refreshTokens(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const rt = await tokens.getRefresh();
      if (!rt) return false;
      const res = await raw('/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken: rt }) }, false);
      if (!res.ok) return false;
      const data = await res.json();
      accessToken = data.accessToken;
      await tokens.setRefresh(data.refreshToken);
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

export async function api<T = unknown>(path: string, init: RequestInit = {}, auth = true): Promise<T> {
  let res = await raw(path, init, auth);
  if (res.status === 401 && auth) {
    if (await refreshTokens()) {
      res = await raw(path, init, auth);
    } else {
      await tokens.clear();
      onSignedOut?.();
    }
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(res.status, body?.message ?? `Request failed (${res.status})`, body);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

/** Used by the socket layer when its handshake token has expired. */
export const refreshAccessToken = () => refreshTokens();
