import { storage } from '../lib/storage';
import { useEffect } from 'react';
import { Alert } from 'react-native';
import { useQueryClient, QueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../state/auth';
import { connectSocket, disconnectSocket, emitAck } from './socket';
import { useLive } from './live-state';
import { ChatMessage, Conversation } from './types';

const bigger = (a: string, b: string) => (BigInt(a) >= BigInt(b) ? a : b);

/** Inserts or replaces a message (matched by clientMsgId) in a conversation's cache, newest first. */
export function upsertMessage(qc: QueryClient, m: ChatMessage) {
  qc.setQueryData<ChatMessage[]>(['messages', m.conversationId], (old) => {
    if (!old) return old; // not opened yet: history is fetched fresh on open
    const i = old.findIndex((x) => x.clientMsgId === m.clientMsgId && x.senderId === m.senderId);
    if (i >= 0) {
      const next = [...old];
      next[i] = m;
      return next;
    }
    return [m, ...old];
  });
}

function patchMessages(qc: QueryClient, conversationId: string, fn: (m: ChatMessage) => ChatMessage) {
  qc.setQueryData<ChatMessage[]>(['messages', conversationId], (old) => old?.map(fn));
}

/** Wires socket events into the query cache. Mount once while signed in. */
export function useChatEvents() {
  const qc = useQueryClient();
  const meId = useAuth((s) => s.me?.id);

  useEffect(() => {
    if (!meId) return;
    const s = connectSocket();
    const live = useLive.getState();

    // Highest message id this device has seen for this account. Persisted so a restart can catch up.
    const cursorKey = `chatCursor.${meId}`;
    let cursor: string | null = null;
    const saveCursor = (id: string) => {
      cursor = cursor ? bigger(cursor, id) : id;
      storage.set(cursorKey, cursor).catch(() => undefined);
    };

    const catchUp = async () => {
      cursor ??= (await storage.get(cursorKey)) ?? null;
      if (cursor === null) {
        // Fresh install: start from the newest message we know about instead of replaying history.
        const convs = await api<Conversation[]>('/conversations').catch(() => []);
        const ids = convs.map((c) => c.lastMessage?.id).filter((x): x is string => !!x);
        saveCursor(ids.reduce((a, b) => bigger(a, b), '0'));
      } else {
        const missed = await api<ChatMessage[]>(`/chat/sync?after=${cursor}`).catch(() => []);
        for (const m of missed) {
          upsertMessage(qc, m);
          saveCursor(m.id);
        }
        const incoming = missed.filter((m) => m.senderId !== meId).map((m) => m.id);
        if (incoming.length) emitAck('message:delivered', { messageIds: incoming });
      }
      qc.invalidateQueries({ queryKey: ['conversations'] });
    };

    s.on('connect', () => void catchUp());
    s.on('message:new', (m: ChatMessage) => {
      upsertMessage(qc, m);
      saveCursor(m.id);
      qc.invalidateQueries({ queryKey: ['conversations'] });
      if (m.senderId !== meId) emitAck('message:delivered', { messageIds: [m.id] });
    });
    s.on('message:status', (p: { messageId: string; conversationId: string; status: ChatMessage['status'] }) =>
      patchMessages(qc, p.conversationId, (m) => (m.id === p.messageId ? { ...m, status: p.status } : m)),
    );
    s.on('conversation:read', (p: { conversationId: string; userId: string; upToMessageId: string }) => {
      if (p.userId === meId) return qc.invalidateQueries({ queryKey: ['conversations'] });
      patchMessages(qc, p.conversationId, (m) =>
        m.senderId === meId && BigInt(m.id) <= BigInt(p.upToMessageId) ? { ...m, status: 'read' } : m,
      );
    });
    s.on('message:deleted', (p: { messageId: string; conversationId: string }) => {
      patchMessages(qc, p.conversationId, (m) =>
        m.id === p.messageId ? { ...m, deleted: true, payload: {}, media: undefined } : m,
      );
      qc.invalidateQueries({ queryKey: ['conversations'] });
    });
    s.on('conversation:new', () => qc.invalidateQueries({ queryKey: ['conversations'] }));
    s.on('conversation:updated', (p: { conversationId: string }) => {
      qc.invalidateQueries({ queryKey: ['conversations'] });
      qc.invalidateQueries({ queryKey: ['conversation', p.conversationId] });
    });
    s.on('conversation:removed', (p: { conversationId: string }) => {
      qc.removeQueries({ queryKey: ['messages', p.conversationId] });
      qc.invalidateQueries({ queryKey: ['conversations'] });
    });
    s.on('account:suspended', () => {
      Alert.alert('Account suspended', 'This account was suspended for breaking the community rules.');
      void useAuth.getState().logout();
    });
    s.on('typing', (p: { conversationId: string; userId: string; isTyping: boolean }) =>
      live.setTyping(p.conversationId, p.userId, p.isTyping),
    );
    s.on('presence', (p: { userId: string; online: boolean; lastSeenAt: string | null }) =>
      live.setPresence(p.userId, p.online, p.lastSeenAt),
    );

    return () => {
      disconnectSocket();
      useLive.getState().reset();
    };
  }, [meId, qc]);
}
