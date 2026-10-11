import { useEffect } from 'react';
import { t } from '../i18n';
import { FlatList, Pressable, View } from 'react-native';
import { Text } from './themed';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Avatar } from './Avatar';
import { connectSocket } from '../chat/socket';
import { StoryGroup, StoryKind, storiesApi } from '../lib/stories';
import { useAuth } from '../state/auth';

/** Horizontal tray of rings. Used for stories (feed) and statuses (chat list). */
export function StoryTray({ kind }: { kind: StoryKind }) {
  const router = useRouter();
  const qc = useQueryClient();
  const me = useAuth((s) => s.me);

  const { data = [] } = useQuery({
    queryKey: ['stories', kind],
    queryFn: () => storiesApi.feed(kind),
    refetchInterval: 60_000, // items expire; keep the tray honest
  });

  useEffect(() => {
    const s = connectSocket();
    const event = kind === 'story' ? 'story:new' : 'status:new';
    const refresh = () => qc.invalidateQueries({ queryKey: ['stories', kind] });
    s.on(event, refresh);
    return () => void s.off(event, refresh);
  }, [kind, qc]);

  const mine = data.find((g) => g.isMe);
  const others = data.filter((g) => !g.isMe);
  const rows: (StoryGroup | 'add')[] = ['add', ...others];

  const open = (authorId: string) =>
    router.push({ pathname: '/story/viewer', params: { kind, authorId } });

  return (
    <FlatList
      horizontal
      data={rows}
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ padding: 10, gap: 14 }}
      keyExtractor={(g) => (g === 'add' ? 'add' : g.author.id)}
      renderItem={({ item }) => {
        if (item === 'add') {
          return (
            <Pressable
              style={{ alignItems: 'center', width: 70 }}
              onPress={() => (mine ? open(me!.id) : router.push({ pathname: '/story/new', params: { kind } }))}
              onLongPress={() => router.push({ pathname: '/story/new', params: { kind } })}
            >
              <View style={ring(!!mine, false)}>
                <Avatar url={me?.avatarUrl} name={me?.displayName ?? me?.username} size={56} />
              </View>
              <Text numberOfLines={1} style={{ fontSize: 12, marginTop: 4 }}>
                {mine ? t(kind === 'story' ? 'Your story' : 'Your status') : t(kind === 'story' ? '+ Add story' : '+ Add status')}
              </Text>
            </Pressable>
          );
        }
        return (
          <Pressable
            style={{ alignItems: 'center', width: 70 }}
            onPress={() => open(item.author.id)}
            accessibilityRole="button"
            accessibilityLabel={`${item.author.displayName ?? item.author.username}'s ${kind}${item.hasUnseen ? ', new' : ''}`}
          >
            <View style={ring(true, item.hasUnseen)}>
              <Avatar url={item.author.avatarUrl} name={item.author.displayName ?? item.author.username} size={56} />
            </View>
            <Text numberOfLines={1} style={{ fontSize: 12, marginTop: 4 }}>
              {item.author.displayName ?? item.author.username}
            </Text>
          </Pressable>
        );
      }}
    />
  );
}

const ring = (exists: boolean, unseen: boolean) => ({
  padding: 3,
  borderRadius: 40,
  borderWidth: 2,
  borderColor: !exists ? '#d1d5db' : unseen ? '#2563eb' : '#9ca3af',
});
