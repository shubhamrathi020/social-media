import { memo, useState } from 'react';
import { Alert, FlatList, Pressable, View, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { Text } from './themed';
import { VideoView, useVideoPlayer } from 'expo-video';
import { InfiniteData, useMutation, useQueryClient } from '@tanstack/react-query';
import { Avatar } from './Avatar';
import { api, json } from '../lib/api';
import { Page, Post, Reaction, Slide, postsApi } from '../lib/posts';
import { useAuth } from '../state/auth';

function VideoSlide({ url, size }: { url: string; size: number }) {
  const player = useVideoPlayer(url, (p) => {
    p.loop = true;
  });
  return <VideoView player={player} style={{ width: size, height: size }} nativeControls contentFit="cover" />;
}

function SlideView({ slide, size }: { slide: Slide; size: number }) {
  const m = slide.media;
  if (!m?.url) return <View style={{ width: size, height: size, backgroundColor: '#ddd' }} />;
  if (m.kind === 'video') return <VideoSlide url={m.url} size={size} />;
  return <Image source={{ uri: m.url }} style={{ width: size, height: size }} contentFit="cover" />;
}

/** Patches one post inside every cached feed/profile page and the single-post cache. */
export function patchPostInCache(qc: ReturnType<typeof useQueryClient>, id: string, fn: (p: Post) => Post) {
  qc.setQueriesData<InfiniteData<Page<Post>>>({ queryKey: ['feed'] }, (d) =>
    d && { ...d, pages: d.pages.map((pg) => ({ ...pg, items: pg.items.map((p) => (p.id === id ? fn(p) : p)) })) },
  );
  qc.setQueryData<Post>(['post', id], (p) => (p ? fn(p) : p));
}

function PostCardBase({ post, onOpen }: { post: Post; onOpen?: () => void }) {
  const { width } = useWindowDimensions();
  const qc = useQueryClient();
  const [index, setIndex] = useState(0);
  const meId = useAuth((s) => s.me?.id);

  function menu() {
    if (post.author.id === meId) {
      Alert.alert('Post', undefined, [
        {
          text: 'Delete post',
          style: 'destructive',
          onPress: async () => {
            try {
              await postsApi.remove(post.id);
              qc.invalidateQueries({ queryKey: ['feed'] });
            } catch (e) {
              Alert.alert('Could not delete', e instanceof Error ? e.message : '');
            }
          },
        },
        { text: 'Cancel', style: 'cancel' },
      ]);
      return;
    }
    const report = (reason: string) =>
      api('/reports', json({ entityType: 'post', entityId: post.id, reason }))
        .then(() => Alert.alert('Thanks', 'We received your report.'))
        .catch((e) => Alert.alert('Could not report', e instanceof Error ? e.message : ''));
    Alert.alert('Report post', 'Why are you reporting this?', [
      { text: 'Spam', onPress: () => report('spam') },
      { text: 'Harassment', onPress: () => report('harassment') },
      { text: 'Nudity', onPress: () => report('nudity') },
      { text: 'Other', onPress: () => report('other') },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  const react = useMutation({
    mutationFn: ({ value }: { value: Reaction }) => postsApi.react(post.id, value),
    onMutate: ({ value }) => {
      // Optimistic: flip the UI now, the server reply (or live counters) corrects it.
      patchPostInCache(qc, post.id, (p) => {
        const prev = p.myReaction;
        return {
          ...p,
          myReaction: value,
          likeCount: p.likeCount + (value === 1 ? 1 : 0) - (prev === 1 ? 1 : 0),
        };
      });
    },
    onSuccess: (r, { value }) =>
      patchPostInCache(qc, post.id, (p) => ({ ...p, likeCount: r.likeCount, commentCount: r.commentCount, myReaction: value })),
    onError: () => qc.invalidateQueries({ queryKey: ['feed'] }),
  });

  const toggle = (value: 1 | -1) => react.mutate({ value: post.myReaction === value ? null : value });

  return (
    <View style={{ marginBottom: 16 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10 }}>
        <Avatar url={post.author.avatarUrl} name={post.author.displayName ?? post.author.username} size={36} />
        <Text style={{ fontWeight: '600' }}>{post.author.displayName ?? post.author.username ?? 'Unknown'}</Text>
        {post.audience !== 'friends' && (
          <Text style={{ color: 'gray', fontSize: 12 }}>
            {post.audience === 'close_friends' ? '★ Close friends' : 'Public'}
          </Text>
        )}
        <Pressable onPress={menu} style={{ marginLeft: 'auto', padding: 6 }} accessibilityRole="button" accessibilityLabel="Post options">
          <Text style={{ fontSize: 18 }}>⋯</Text>
        </Pressable>
      </View>

      {post.underReview && (
        <Text
          accessibilityRole="alert"
          style={{ marginHorizontal: 10, marginBottom: 6, padding: 8, borderRadius: 8, backgroundColor: '#fef3c7', color: '#92400e' }}
        >
          Only you can see this post while it is being reviewed.
        </Text>
      )}
      <FlatList
        data={post.slides}
        keyExtractor={(s) => String(s.position)}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={(e) => setIndex(Math.round(e.nativeEvent.contentOffset.x / width))}
        renderItem={({ item }) => <SlideView slide={item} size={width} />}
      />
      {post.slides.length > 1 && (
        <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 6, paddingTop: 8 }}>
          {post.slides.map((s, i) => (
            <View
              key={s.position}
              style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: i === index ? '#2563eb' : '#ccc' }}
            />
          ))}
        </View>
      )}

      <View style={{ flexDirection: 'row', gap: 20, padding: 10, alignItems: 'center' }}>
        <Pressable
          onPress={() => toggle(1)}
          accessibilityRole="button"
          accessibilityLabel={`Like, ${post.likeCount} ${post.likeCount === 1 ? 'like' : 'likes'}`}
          accessibilityState={{ selected: post.myReaction === 1 }}
        >
          <Text style={{ fontSize: 16 }}>{post.myReaction === 1 ? '❤️' : '🤍'} {post.likeCount}</Text>
        </Pressable>
        <Pressable
          onPress={() => toggle(-1)}
          accessibilityRole="button"
          accessibilityLabel="Dislike"
          accessibilityState={{ selected: post.myReaction === -1 }}
        >
          <Text style={{ fontSize: 16, opacity: post.myReaction === -1 ? 1 : 0.5 }}>👎</Text>
        </Pressable>
        <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel={`Comments, ${post.commentCount}`}>
          <Text style={{ fontSize: 16 }}>💬 {post.commentCount}</Text>
        </Pressable>
        {post.dislikeCount !== undefined && (
          <Text style={{ color: 'gray', marginLeft: 'auto' }}>{post.dislikeCount} dislikes</Text>
        )}
      </View>
      {!!post.caption && (
        <Text style={{ paddingHorizontal: 10 }}>
          <Text style={{ fontWeight: '600' }}>{post.author.username ?? post.author.displayName} </Text>
          {post.caption}
        </Text>
      )}
    </View>
  );
}

export const PostCard = memo(PostCardBase);
