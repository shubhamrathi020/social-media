import { create } from 'zustand';

interface LiveState {
  /** conversationId -> userIds currently typing */
  typing: Record<string, string[]>;
  /** userId -> presence */
  presence: Record<string, { online: boolean; lastSeenAt: string | null }>;
  setTyping: (conversationId: string, userId: string, isTyping: boolean) => void;
  setPresence: (userId: string, online: boolean, lastSeenAt: string | null) => void;
  mergePresence: (p: LiveState['presence']) => void;
  reset: () => void;
}

export const useLive = create<LiveState>((set) => ({
  typing: {},
  presence: {},
  setTyping: (conversationId, userId, isTyping) =>
    set((s) => {
      const cur = new Set(s.typing[conversationId] ?? []);
      if (isTyping) cur.add(userId);
      else cur.delete(userId);
      return { typing: { ...s.typing, [conversationId]: [...cur] } };
    }),
  setPresence: (userId, online, lastSeenAt) =>
    set((s) => ({ presence: { ...s.presence, [userId]: { online, lastSeenAt } } })),
  mergePresence: (p) => set((s) => ({ presence: { ...s.presence, ...p } })),
  reset: () => set({ typing: {}, presence: {} }),
}));
