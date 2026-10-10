import { Platform } from 'react-native';
import { create } from 'zustand';
import { api, json, tokens } from '../lib/api';

export interface Me {
  id: string;
  phone: string;
  username: string | null;
  displayName: string | null;
  bio: string;
  isPrivate: boolean;
  avatarMediaId: string | null;
  avatarUrl: string | null;
}

interface AuthState {
  status: 'loading' | 'signedOut' | 'signedIn';
  me: Me | null;
  bootstrap: () => Promise<void>;
  requestOtp: (phone: string) => Promise<void>;
  verifyOtp: (phone: string, code: string) => Promise<void>;
  updateProfile: (patch: Partial<Pick<Me, 'username' | 'displayName' | 'bio' | 'isPrivate' | 'avatarMediaId'>>) => Promise<void>;
  logout: () => Promise<void>;
}

const platform = Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web';

export const useAuth = create<AuthState>((set) => {
  tokens.onSignedOut(() => set({ status: 'signedOut', me: null }));

  return {
    status: 'loading',
    me: null,

    async bootstrap() {
      // A stored refresh token means we may be signed in; /users/me triggers a refresh via the 401 path.
      if (!(await tokens.getRefresh())) return set({ status: 'signedOut' });
      try {
        const me = await api<Me>('/users/me');
        set({ status: 'signedIn', me });
      } catch {
        set({ status: 'signedOut', me: null });
      }
    },

    async requestOtp(phone) {
      await api('/auth/otp/request', json({ phone }), false);
    },

    async verifyOtp(phone, code) {
      const r = await api<{ accessToken: string; refreshToken: string }>(
        '/auth/otp/verify',
        json({ phone, code, device: { platform } }),
        false,
      );
      tokens.setAccess(r.accessToken);
      await tokens.setRefresh(r.refreshToken);
      const me = await api<Me>('/users/me');
      set({ status: 'signedIn', me });
    },

    async updateProfile(patch) {
      const me = await api<Me>('/users/me', { method: 'PATCH', body: JSON.stringify(patch) });
      set({ me });
    },

    async logout() {
      await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
      await tokens.clear();
      set({ status: 'signedOut', me: null });
    },
  };
});
