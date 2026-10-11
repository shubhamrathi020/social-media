import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, View, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { Text, TextInput } from '../../src/components/themed';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { VideoView, useVideoPlayer } from 'expo-video';
import { StoryItem, StoryKind, storiesApi } from '../../src/lib/stories';
import { ApiError } from '../../src/lib/api';
import { sendEncrypted } from '../../src/chat/e2e';

const IMAGE_MS = 5000;

function VideoItem({ url }: { url: string }) {
  const player = useVideoPlayer(url, (p) => {
    p.play();
  });
  return <VideoView player={player} style={{ flex: 1 }} contentFit="contain" nativeControls={false} />;
}

export default function StoryViewer() {
  const { kind, authorId } = useLocalSearchParams<{ kind: StoryKind; authorId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const { width } = useWindowDimensions();

  const { data: groups = [] } = useQuery({ queryKey: ['stories', kind], queryFn: () => storiesApi.feed(kind) });
  const group = groups.find((g) => g.author.id === authorId);
  const items = group?.items ?? [];

  // Start at the first unseen item, like Instagram.
  const [index, setIndex] = useState<number | null>(null);
  useEffect(() => {
    if (index === null && items.length) {
      const firstUnseen = items.findIndex((i) => !i.seen);
      setIndex(firstUnseen >= 0 ? firstUnseen : 0);
    }
  }, [items, index]);

  const current: StoryItem | undefined = index === null ? undefined : items[index];
  const [reply, setReply] = useState('');
  const [paused, setPaused] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const next = () => {
    if (index === null) return;
    if (index + 1 < items.length) setIndex(index + 1);
    else router.back();
  };
  const prev = () => index !== null && index > 0 && setIndex(index - 1);

  // Mark viewed and auto-advance.
  useEffect(() => {
    if (!current) return;
    if (!group?.isMe && !current.seen) {
      storiesApi.view(current.id).then(() => qc.invalidateQueries({ queryKey: ['stories', kind] })).catch(() => undefined);
    }
    if (timer.current) clearTimeout(timer.current);
    if (paused) return;
    const ms = current.media?.kind === 'video' ? (current.media.durationMs ?? IMAGE_MS) : IMAGE_MS;
    timer.current = setTimeout(next, ms);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, paused]);

  const content = useMemo(() => {
    if (!current) return null;
    if (current.media?.kind === 'video' && current.media.url) return <VideoItem url={current.media.url} />;
    if (current.media?.url) {
      return <Image source={{ uri: current.media.url }} style={{ flex: 1 }} contentFit="contain" />;
    }
    return (
      <View style={{ flex: 1, backgroundColor: current.background ?? '#2563eb', justifyContent: 'center', padding: 24 }}>
        <Text style={{ color: 'white', fontSize: 28, fontWeight: '700', textAlign: 'center' }}>{current.text}</Text>
      </View>
    );
  }, [current]);

  async function sendReply() {
    if (!current || !reply.trim()) return;
    try {
      try {
        await storiesApi.reply(current.id, reply.trim());
      } catch (e) {
        // Chats with this person are end-to-end encrypted, so the server cannot write the reply for us.
        if (!(e instanceof ApiError && e.body?.code === 'E2E_CONVERSATION')) throw e;
        const res = await sendEncrypted({
          conversationId: String(e.body.conversationId),
          clientMsgId: `story-${current.id}-${Date.now()}`,
          type: 'text',
          payload: { text: reply.trim(), storyId: current.id },
        });
        if (!res.ok) throw new Error(res.error.message);
      }
      setReply('');
      setPaused(false);
      Alert.alert('Sent', 'Your reply was sent as a message.');
    } catch (e) {
      Alert.alert('Could not reply', e instanceof Error ? e.message : '');
    }
  }

  async function remove() {
    if (!current) return;
    await storiesApi.remove(current.id).catch(() => undefined);
    await qc.invalidateQueries({ queryKey: ['stories', kind] });
    router.back();
  }

  if (!group || !current) {
    return (
      <View style={{ flex: 1, backgroundColor: 'black', alignItems: 'center', justifyContent: 'center' }}>
        <Stack.Screen options={{ headerShown: false }} />
        <Text style={{ color: 'white' }} onPress={() => router.back()}>Nothing to show · tap to close</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: 'black' }}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={{ flexDirection: 'row', gap: 4, paddingTop: 48, paddingHorizontal: 8 }}>
        {items.map((it, i) => (
          <View
            key={it.id}
            style={{ flex: 1, height: 3, borderRadius: 2, backgroundColor: i <= (index ?? 0) ? 'white' : '#ffffff55' }}
          />
        ))}
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', padding: 12 }}>
        <Text style={{ color: 'white', fontWeight: '600' }}>
          {group.isMe ? 'You' : (group.author.displayName ?? group.author.username)}
          {current.audience === 'close_friends' ? '  ★' : ''}
        </Text>
        <Text style={{ color: 'white' }} onPress={() => router.back()}>✕</Text>
      </View>

      <View style={{ flex: 1 }}>
        {content}
        <Pressable
          style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: width * 0.3 }}
          onPress={prev}
          onLongPress={() => setPaused(true)}
          onPressOut={() => setPaused(false)}
        />
        <Pressable
          style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: width * 0.7 }}
          onPress={next}
          onLongPress={() => setPaused(true)}
          onPressOut={() => setPaused(false)}
        />
        {!!current.media && !!current.text && (
          <Text style={{ position: 'absolute', bottom: 16, alignSelf: 'center', color: 'white', fontSize: 18 }}>
            {current.text}
          </Text>
        )}
      </View>

      {group.isMe ? (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', padding: 16 }}>
          <Text style={{ color: 'white' }}>👁 {current.viewCount ?? 0}</Text>
          <Text style={{ color: '#fca5a5' }} onPress={remove}>Delete</Text>
        </View>
      ) : (
        <TextInput
          value={reply}
          onChangeText={setReply}
          onFocus={() => setPaused(true)}
          onBlur={() => setPaused(false)}
          onSubmitEditing={sendReply}
          placeholder="Reply…"
          placeholderTextColor="#aaa"
          returnKeyType="send"
          style={{ margin: 12, borderWidth: 1, borderColor: '#666', borderRadius: 20, color: 'white', paddingHorizontal: 14, paddingVertical: 8 }}
        />
      )}
    </View>
  );
}
