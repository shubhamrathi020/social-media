import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, FlatList, KeyboardAvoidingView, Platform, Pressable, View } from 'react-native';
import { Image } from 'expo-image';
import { Text, TextInput } from '../../src/components/themed';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../src/lib/api';
import { pickFromLibrary, uploadMedia } from '../../src/lib/media';
import { useAuth } from '../../src/state/auth';
import { emitAck } from '../../src/chat/socket';
import { useLive } from '../../src/chat/live-state';
import { upsertMessage } from '../../src/chat/use-chat-events';
import { ChatMessage, Conversation, conversationTitle, describeSystem, memberName } from '../../src/chat/types';
import { useTheme } from '../../src/theme';
import { decryptIncoming, sendEncrypted, uploadEncryptedFile } from '../../src/chat/e2e';
import { EncryptedImage } from '../../src/components/EncryptedImage';

// A stable empty list: returning a fresh [] from a store selector makes Zustand re-render forever.
const NO_TYPERS: string[] = [];

const TICKS: Record<string, string> = { sending: '…', sent: '✓', delivered: '✓✓', read: '✓✓', failed: '!' };
const uuid = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });

export default function ChatScreen() {
  const { id, title } = useLocalSearchParams<{ id: string; title?: string }>();
  const meId = useAuth((s) => s.me!.id);
  const c = useTheme();
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTypingSent = useRef(false);

  const typers = useLive((s) => s.typing[id] ?? NO_TYPERS).filter((u) => u !== meId);
  const router = useRouter();

  // The conversation (title, members) comes from the list cache, refreshed when the group changes.
  const { data: conversations } = useQuery({
    queryKey: ['conversations'],
    queryFn: () => api<Conversation[]>('/conversations'),
  });
  const conv = conversations?.find((x) => x.id === id);
  const names = useMemo(
    () => new Map((conv?.members ?? []).map((m) => [m.id, memberName(m)] as const)),
    [conv?.members],
  );
  const headerTitle = conv ? conversationTitle(conv, meId) : (title ?? 'Chat');
  // Stable options object: expo-router re-applies options whenever their identity changes.
  const screenOptions = useMemo(
    () => ({
      headerShown: true,
      title: headerTitle,
      headerRight: () => (
        <Button title="Info" onPress={() => router.push({ pathname: '/chat/info', params: { id } })} />
      ),
    }),
    [headerTitle, id, router],
  );

  const { data: messages = [] } = useQuery({
    queryKey: ['messages', id],
    queryFn: async () => (await api<ChatMessage[]>(`/conversations/${id}/messages?limit=40`)).map(decryptIncoming),
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
    const older = (await api<ChatMessage[]>(`/conversations/${id}/messages?limit=40&before=${oldest.id}`)).map(decryptIncoming);
    if (older.length) qc.setQueryData<ChatMessage[]>(['messages', id], (cur) => [...(cur ?? []), ...older]);
  }, [messages, id, qc]);

  async function sendMessage(type: ChatMessage['type'], payload: ChatMessage['payload'], attachmentId?: string) {
    const clientMsgId = uuid();
    const optimistic: ChatMessage = {
      id: `local-${clientMsgId}`, conversationId: id, senderId: meId, clientMsgId, type, payload,
      replyToId: null, createdAt: new Date().toISOString(), deleted: false, status: 'sending',
    };
    upsertMessage(qc, optimistic);
    const res = conv?.e2e
      ? await sendEncrypted({ conversationId: id, clientMsgId, type, payload, attachmentId })
      : await emitAck<{ message: ChatMessage }>('message:send', { conversationId: id, clientMsgId, type, payload });
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
      if (conv?.e2e) {
        // Encrypted on the phone; the server stores an unreadable blob and never sees the photo.
        const sealed = await uploadEncryptedFile(file.uri);
        await sendMessage('image', { fileKey: sealed.fileKey, fileNonce: sealed.fileNonce, mime: file.mime }, sealed.attachmentId);
        return;
      }
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
    if (m.deleted || m.type === 'system' || m.id.startsWith('local-')) return;
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
      <Stack.Screen options={screenOptions} />
      <FlatList<ChatMessage>
        inverted
        data={messages}
        keyExtractor={(m) => m.clientMsgId}
        onEndReached={loadOlder}
        contentContainerStyle={{ padding: 12, gap: 6 }}
        renderItem={({ item }) => {
          if (item.type === 'system') {
            return (
              <Text style={{ alignSelf: 'center', color: c.muted, fontSize: 13, paddingVertical: 4, textAlign: 'center' }}>
                {describeSystem(item, names, meId)}
              </Text>
            );
          }
          const mine = item.senderId === meId;
          const showSender = conv?.type === 'group' && !mine;
          return (
            <Pressable
              onLongPress={() => onLongPress(item)}
              style={{
                alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '80%', padding: 10, borderRadius: 14,
                backgroundColor: mine ? '#2563eb' : c.subtle,
              }}
            >
              {showSender && (
                <Text style={{ fontSize: 12, fontWeight: '700', color: c.primary, marginBottom: 2 }}>
                  {names.get(item.senderId) ?? 'Former member'}
                </Text>
              )}
              {item.deleted ? (
                <Text style={{ fontStyle: 'italic', color: mine ? '#dbeafe' : 'gray' }}>Message deleted</Text>
              ) : (
                <>
                  {item.undecryptable && (
                    <Text style={{ fontStyle: 'italic', color: mine ? '#dbeafe' : c.muted }}>
                      🔒 Sent before you signed in on this device
                    </Text>
                  )}
                  {item.encrypted && item.type === 'image' && !item.undecryptable && <EncryptedImage message={item} />}
                  {!item.encrypted && item.media?.thumbUrl && (
                    <Image
                      source={{ uri: item.media.thumbUrl }}
                      style={{ width: 200, height: 150, borderRadius: 8, marginBottom: 4 }}
                      cachePolicy="memory-disk"
                      accessibilityLabel="Photo"
                    />
                  )}
                  {!!(item.payload.text ?? item.payload.caption) && (
                    <Text style={{ color: mine ? 'white' : c.text, fontSize: 16 }}>
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
      <View style={{ flexDirection: 'row', padding: 8, gap: 8, alignItems: 'center', borderTopWidth: 1, borderColor: c.border }}>
        <Pressable onPress={sendPhoto} accessibilityRole="button" accessibilityLabel="Send a photo"><Text style={{ fontSize: 24 }}>📷</Text></Pressable>
        <TextInput
          value={text}
          onChangeText={onChange}
          placeholder={conv?.e2e ? 'Encrypted message' : 'Message'}
          multiline
          style={{ flex: 1, borderWidth: 1, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8, maxHeight: 120 }}
        />
        <Pressable onPress={sendText} disabled={!text.trim()} accessibilityRole="button" accessibilityLabel="Send message">
          <Text style={{ fontSize: 16, fontWeight: '700', color: text.trim() ? '#2563eb' : '#aaa' }}>Send</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
