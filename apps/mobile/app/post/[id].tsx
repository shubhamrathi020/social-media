import { useEffect, useState } from 'react';
import { Alert, Button, FlatList, KeyboardAvoidingView, Platform, Pressable, View } from 'react-native';
import { Text, TextInput } from '../../src/components/themed';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Avatar } from '../../src/components/Avatar';
import { PostCard, patchPostInCache } from '../../src/components/PostCard';
import { connectSocket, emitAck } from '../../src/chat/socket';
import { Comment, Page, Post, postsApi } from '../../src/lib/posts';
import { useAuth } from '../../src/state/auth';

export default function PostScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const meId = useAuth((s) => s.me!.id);
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState<Comment | null>(null);

  const post = useQuery({ queryKey: ['post', id], queryFn: () => postsApi.get(id) });
  const comments = useInfiniteQuery({
    queryKey: ['comments', id],
    queryFn: ({ pageParam }) => postsApi.comments(id, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last: Page<Comment>) => last.nextCursor,
  });

  // Live counters and new comments while this screen is open.
  useEffect(() => {
    const s = connectSocket();
    emitAck('post:subscribe', { postId: id });
    const onCounters = (p: { postId: string; likeCount: number; commentCount: number }) => {
      if (p.postId === id) {
        patchPostInCache(qc, id, (x: Post) => ({ ...x, likeCount: p.likeCount, commentCount: p.commentCount }));
      }
    };
    const onNew = (c: Comment) => {
      if (c.postId !== id || c.author.id === meId || c.parentId) return;
      qc.invalidateQueries({ queryKey: ['comments', id] });
    };
    const onDeleted = () => qc.invalidateQueries({ queryKey: ['comments', id] });
    s.on('post:counters', onCounters);
    s.on('comment:new', onNew);
    s.on('comment:deleted', onDeleted);
    return () => {
      s.off('post:counters', onCounters);
      s.off('comment:new', onNew);
      s.off('comment:deleted', onDeleted);
      emitAck('post:unsubscribe', { postId: id });
    };
  }, [id, meId, qc]);

  async function submit() {
    const body = text.trim();
    if (!body) return;
    try {
      await postsApi.addComment(id, body, replyTo?.id);
      setText('');
      setReplyTo(null);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['comments', id] }),
        qc.invalidateQueries({ queryKey: ['post', id] }),
      ]);
    } catch (e) {
      Alert.alert('Could not comment', e instanceof Error ? e.message : '');
    }
  }

  function remove(c: Comment) {
    Alert.alert('Delete comment?', undefined, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await postsApi.removeComment(c.id).catch((e) => Alert.alert('Could not delete', String(e.message)));
          qc.invalidateQueries({ queryKey: ['comments', id] });
          qc.invalidateQueries({ queryKey: ['post', id] });
        },
      },
    ]);
  }

  const items = comments.data?.pages.flatMap((p) => p.items) ?? [];
  const canDelete = (c: Comment) => c.author.id === meId || post.data?.author.id === meId;

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Stack.Screen options={{ headerShown: true, title: 'Post' }} />
      <FlatList<Comment>
        data={items}
        keyExtractor={(c) => c.id}
        onEndReached={() => comments.hasNextPage && comments.fetchNextPage()}
        ListHeaderComponent={post.data ? <PostCard post={post.data} /> : null}
        ListEmptyComponent={<Text style={{ padding: 16, color: 'gray' }}>No comments yet.</Text>}
        renderItem={({ item }) => (
          <View style={{ flexDirection: 'row', gap: 10, paddingHorizontal: 12, paddingVertical: 8 }}>
            <Avatar url={item.author.avatarUrl} name={item.author.displayName ?? item.author.username} size={32} />
            <View style={{ flex: 1 }}>
              <Text>
                <Text style={{ fontWeight: '600' }}>{item.author.displayName ?? item.author.username} </Text>
                {item.deleted ? <Text style={{ fontStyle: 'italic', color: 'gray' }}>deleted</Text> : item.body}
              </Text>
              <View style={{ flexDirection: 'row', gap: 16, marginTop: 4 }}>
                <Pressable onPress={() => setReplyTo(item)}><Text style={{ color: 'gray' }}>Reply</Text></Pressable>
                {!item.deleted && (
                  <Pressable
                    onPress={async () => {
                      await postsApi.reactComment(item.id, item.myReaction === 1 ? null : 1);
                      qc.invalidateQueries({ queryKey: ['comments', id] });
                    }}
                  >
                    <Text style={{ color: item.myReaction === 1 ? '#e11d48' : 'gray' }}>
                      {item.myReaction === 1 ? '❤️' : '🤍'} {item.likeCount}
                    </Text>
                  </Pressable>
                )}
                {!item.deleted && canDelete(item) && (
                  <Pressable onPress={() => remove(item)}><Text style={{ color: 'crimson' }}>Delete</Text></Pressable>
                )}
              </View>
              {item.replyCount > 0 && <Replies postId={id} parentId={item.id} />}
            </View>
          </View>
        )}
      />
      {replyTo && (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 12 }}>
          <Text style={{ color: 'gray' }}>Replying to {replyTo.author.displayName ?? replyTo.author.username}</Text>
          <Pressable onPress={() => setReplyTo(null)} accessibilityRole="button" accessibilityLabel="Cancel reply"><Text>✕</Text></Pressable>
        </View>
      )}
      <View style={{ flexDirection: 'row', padding: 8, gap: 8, alignItems: 'center', borderTopWidth: 1, borderColor: '#eee' }}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Add a comment…"
          maxLength={1000}
          style={{ flex: 1, borderWidth: 1, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8 }}
        />
        <Button title="Post" onPress={submit} disabled={!text.trim()} />
      </View>
    </KeyboardAvoidingView>
  );
}

function Replies({ postId, parentId }: { postId: string; parentId: string }) {
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ['replies', parentId],
    queryFn: () => postsApi.comments(postId, null, parentId),
    enabled: open,
  });
  return (
    <View style={{ marginTop: 6 }}>
      {!open ? (
        <Pressable onPress={() => setOpen(true)}><Text style={{ color: 'gray' }}>View replies</Text></Pressable>
      ) : (
        (q.data?.items ?? []).map((r) => (
          <Text key={r.id} style={{ marginTop: 4 }}>
            <Text style={{ fontWeight: '600' }}>{r.author.displayName ?? r.author.username} </Text>
            {r.body}
          </Text>
        ))
      )}
    </View>
  );
}
