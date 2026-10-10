import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, FlatList, Image, KeyboardAvoidingView, Platform, Pressable, Text, TextInput, View,
} from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../src/lib/api';
import { pickFromLibrary, uploadMedia } from '../../src/lib/media';
import { useAuth } from '../../src/state/auth';
import { emitAck } from '../../src/chat/socket';
import { useLive } from '../../src/chat/live-state';
import { upsertMessage } from '../../src/chat/use-chat-events';
import { ChatMessage } from '../../src/chat/types';

const TICKS: Record<string, string> = { sending: '…', sent: '✓', delivered: '✓✓', read: '✓✓', failed: '!' };
const uuid = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });

export default function ChatScreen() {
  const { id, title } = useLocalSearchParams<{ id: string; title?: string }>();
  const meId = useAuth((s) => s.me!.id);
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTypingSent = useRef(false);

  const typers = useLive((s) => s.typing[id] ?? []).filter((u) => u !== meId);

  const { data: messages = [] } = useQuery({
    queryKey: ['messages', id],
    queryFn: () => api<ChatMessage[]>(`/conversations/${id}/messages?limit=40`),
  });

  // Mark everything from others as read whenever a newer one arrives while the screen is open.
  const newestIncoming = useMemo(() => messages.find((m) => m.senderId !== meId)?.id, [messages, meId]);
  useEffect(() => {
    if (newestIncoming) {
      emitAck('message:read', { conversationId: id, upToMessageId: newestIncoming }).then(() =>
        qc.invalidateQueries({ queryKey: ['conversations'] }),
      );
    }
  }, [newestIncoming, id, qc]);

  const loadOlder = useCallback(async () => {
    const oldest = messages[messages.length - 1];
    if (!oldest) return;
    const older = await api<ChatMessage[]>(`/conversations/${id}/messages?limit=40&before=${oldest.id}`);
    if (older.length) qc.setQueryData<ChatMessage[]>(['messages', id], (cur) => [...(cur ?? []), ...older]);
  }, [messages, id, qc]);

  async function sendMessage(type: ChatMessage['type'], payload: ChatMessage['payload']) {
    const clientMsgId = uuid();
    const optimistic: ChatMessage = {
      id: `local-${clientMsgId}`, conversationId: id, senderId: meId, clientMsgId, type, payload,
      replyToId: null, createdAt: new Date().toISOString(), deleted: false, status: 'sending',
    };
    upsertMessage(qc, optimistic);
    const res = await emitAck<{ message: ChatMessage }>('message:send', {
      conversationId: id, clientMsgId, type, payload,
    });
    if (res.ok) upsertMessage(qc, res.data.message);
    else upsertMessage(qc, { ...optimistic, status: 'failed' });
  }

  async function sendText() {
    const t = text.trim();
    if (!t) return;
    setText('');
    stopTyping();
    await sendMessage('text', { text: t });
  }

  async function sendPhoto() {
    try {
      const file = await pickFromLibrary(['image']);
      if (!file) return;
      const media = await uploadMedia(file, 'chat');
      await sendMessage('image', { mediaId: media.id });
    } catch (e) {
      Alert.alert('Could not send photo', e instanceof Error ? e.message : '');
    }
  }

  function onChange(v: string) {
    setText(v);
    if (!isTypingSent.current && v) {
      isTypingSent.current = true;
      emitAck('typing:start', { conversationId: id });
    }
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(stopTyping, 2000);
  }
  function stopTyping() {
    if (typingTimer.current) clearTimeout(typingTimer.current);
    if (isTypingSent.current) {
      isTypingSent.current = false;
      emitAck('typing:stop', { conversationId: id });
    }
  }
  useEffect(() => () => stopTyping(), []); // eslint-disable-line react-hooks/exhaustive-deps

  function onLongPress(m: ChatMessage) {
    if (m.deleted || m.id.startsWith('local-')) return;
    const buttons: Parameters<typeof Alert.alert>[2] = [
      { text: 'Delete for me', onPress: () => remove(m, 'me') },
    ];
    if (m.senderId === meId) buttons.push({ text: 'Delete for everyone', style: 'destructive', onPress: () => remove(m, 'everyone') });
    buttons.push({ text: 'Cancel', style: 'cancel' });
    Alert.alert('Message', undefined, buttons);
  }
  async function remove(m: ChatMessage, scope: 'me' | 'everyone') {
    try {
      await api(`/messages/${m.id}?scope=${scope}`, { method: 'DELETE' });
      qc.setQueryData<ChatMessage[]>(['messages', id], (cur) =>
        scope === 'me'
          ? cur?.filter((x) => x.id !== m.id)
          : cur?.map((x) => (x.id === m.id ? { ...x, deleted: true, payload: {}, media: undefined } : x)),
      );
    } catch (e) {
      Alert.alert('Could not delete', e instanceof Error ? e.message : '');
    }
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={90}
    >
      <Stack.Screen options={{ headerShown: true, title: title ?? 'Chat' }} />
      <FlatList<ChatMessage>
        inverted
        data={messages}
        keyExtractor={(m) => m.clientMsgId}
        onEndReached={loadOlder}
        contentContainerStyle={{ padding: 12, gap: 6 }}
        renderItem={({ item }) => {
          const mine = item.senderId === meId;
          return (
            <Pressable
              onLongPress={() => onLongPress(item)}
              style={{
                alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '80%', padding: 10, borderRadius: 14,
                backgroundColor: mine ? '#2563eb' : '#e5e7eb',
              }}
            >
              {item.deleted ? (
                <Text style={{ fontStyle: 'italic', color: mine ? '#dbeafe' : 'gray' }}>Message deleted</Text>
              ) : (
                <>
                  {item.media?.thumbUrl && (
                    <Image
                      source={{ uri: item.media.thumbUrl }}
                      style={{ width: 200, height: 150, borderRadius: 8, marginBottom: 4 }}
                    />
                  )}
                  {!!(item.payload.text ?? item.payload.caption) && (
                    <Text style={{ color: mine ? 'white' : 'black', fontSize: 16 }}>
                      {item.payload.text ?? item.payload.caption}
                    </Text>
                  )}
                </>
              )}
              {mine && item.status && (
                <Text
                  style={{
                    alignSelf: 'flex-end', fontSize: 11, marginTop: 2,
                    color: item.status === 'read' ? '#93c5fd' : item.status === 'failed' ? '#fecaca' : '#dbeafe',
                  }}
                >
                  {TICKS[item.status]}
                </Text>
              )}
            </Pressable>
          );
        }}
      />
      {typers.length > 0 && <Text style={{ paddingHorizontal: 16, color: 'gray' }}>typing…</Text>}
      <View style={{ flexDirection: 'row', padding: 8, gap: 8, alignItems: 'center', borderTopWidth: 1, borderColor: '#eee' }}>
        <Pressable onPress={sendPhoto}><Text style={{ fontSize: 24 }}>📷</Text></Pressable>
        <TextInput
          value={text}
          onChangeText={onChange}
          placeholder="Message"
          multiline
          style={{ flex: 1, borderWidth: 1, borderColor: '#ddd', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8, maxHeight: 120 }}
        />
        <Pressable onPress={sendText} disabled={!text.trim()}>
          <Text style={{ fontSize: 16, fontWeight: '700', color: text.trim() ? '#2563eb' : '#aaa' }}>Send</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
