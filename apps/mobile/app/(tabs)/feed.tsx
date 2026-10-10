import { Button, FlatList, Text, View } from 'react-native';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { StoryTray } from '../../src/components/StoryTray';
import { PostCard } from '../../src/components/PostCard';
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
          <StoryTray kind="story" />
          <View style={{ padding: 10 }}>
            <Button title="New post" onPress={() => router.push('/post/new')} />
          </View>
        </View>
      }
      ListEmptyComponent={
        q.isLoading ? null : <Text style={{ padding: 24 }}>Nothing here yet. Add friends or create a post.</Text>
      }
      renderItem={({ item }) => (
        <PostCard post={item} onOpen={() => router.push({ pathname: '/post/[id]', params: { id: item.id } })} />
      )}
    />
  );
}
