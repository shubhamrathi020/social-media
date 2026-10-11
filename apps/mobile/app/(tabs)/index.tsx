import { Button, FlatList, View } from 'react-native';
import { t } from '../../src/i18n';
import { Text } from '../../src/components/themed';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { LiveNow } from '../../src/components/LiveNow';
import { StoryTray } from '../../src/components/StoryTray';
import { PostCard } from '../../src/components/PostCard';
import { ErrorState } from '../../src/components/ErrorState';
import { Post, postsApi } from '../../src/lib/posts';

export default function FeedScreen() {
  const router = useRouter();
  const q = useInfiniteQuery({
    queryKey: ['feed'],
    queryFn: ({ pageParam }) => postsApi.feed(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const posts: Post[] = q.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <FlatList<Post>
      data={posts}
      keyExtractor={(p) => p.id}
      refreshing={q.isRefetching}
      onRefresh={() => q.refetch()}
      onEndReached={() => q.hasNextPage && !q.isFetchingNextPage && q.fetchNextPage()}
      onEndReachedThreshold={0.5}
      ListHeaderComponent={
        <View>
          <LiveNow />
          <StoryTray kind="story" />
          <View style={{ padding: 10 }}>
            <Button title={t('New post')} onPress={() => router.push('/post/new')} />
          </View>
        </View>
      }
      ListEmptyComponent={
        q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : q.isLoading ? null : (
          <Text style={{ padding: 24 }}>{t('Nothing here yet. Add friends or create a post.')}</Text>
        )
      }
      renderItem={({ item }) => (
        <PostCard post={item} onOpen={() => router.push({ pathname: '/post/[id]', params: { id: item.id } })} />
      )}
    />
  );
}
