import { useEffect } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Avatar } from '../../src/components/Avatar';
import { connectSocket } from '../../src/chat/socket';
import { Notification, notificationsApi } from '../../src/lib/settings';

const TEXT: Record<Notification['type'], (n: Notification) => string> = {
  friend_request: () => 'sent you a friend request',
  friend_accepted: () => 'accepted your friend request',
  post_liked: () => 'liked your post',
  comment: (n) => `commented: ${n.data.preview ?? ''}`,
  comment_reply: (n) => `replied: ${n.data.preview ?? ''}`,
  live_started: (n) => `is live${n.data.title ? `: ${n.data.title}` : ''}`,
};

export default function Alerts() {
  const router = useRouter();
  const qc = useQueryClient();

  const q = useInfiniteQuery({
    queryKey: ['notifications'],
    queryFn: ({ pageParam }) => notificationsApi.list(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  useEffect(() => {
    const s = connectSocket();
    const refresh = () => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
      qc.invalidateQueries({ queryKey: ['unread'] });
    };
    s.on('notification:new', refresh);
    return () => void s.off('notification:new', refresh);
  }, [qc]);

  // Opening the tab marks everything read.
  useEffect(() => {
    if (items.some((n) => !n.readAt)) {
      notificationsApi.markAllRead().then(() => qc.invalidateQueries({ queryKey: ['unread'] }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length]);

  const open = (n: Notification) => {
    if (n.entityType === 'post' && n.entityId) router.push({ pathname: '/post/[id]', params: { id: n.entityId } });
    else if (n.entityType === 'live' && n.entityId) router.push({ pathname: '/live/[id]', params: { id: n.entityId } });
    else router.push('/friends');
  };

  return (
    <FlatList<Notification>
      data={items}
      keyExtractor={(n) => n.id}
      refreshing={q.isRefetching}
      onRefresh={() => q.refetch()}
      onEndReached={() => q.hasNextPage && !q.isFetchingNextPage && q.fetchNextPage()}
      ListEmptyComponent={q.isLoading ? null : <Text style={{ padding: 24, color: 'gray' }}>No notifications yet.</Text>}
      renderItem={({ item }) => (
        <Pressable
          onPress={() => open(item)}
          style={{
            flexDirection: 'row', gap: 12, padding: 12, alignItems: 'center',
            backgroundColor: item.readAt ? 'transparent' : '#eff6ff',
          }}
        >
          <Avatar url={item.actor?.avatarUrl} name={item.actor?.displayName ?? item.actor?.username} />
          <View style={{ flex: 1 }}>
            <Text>
              <Text style={{ fontWeight: '700' }}>{item.actor?.displayName ?? item.actor?.username ?? 'Someone'} </Text>
              {TEXT[item.type](item)}
            </Text>
            <Text style={{ color: 'gray', fontSize: 12 }}>{new Date(item.createdAt).toLocaleString()}</Text>
          </View>
        </Pressable>
      )}
    />
  );
}
