import { Alert, Button, SectionList, Text, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Avatar } from '../../src/components/Avatar';
import { Friend, FriendRequest, Suggestion, friendsApi, nameOf } from '../../src/lib/friends';

type Item =
  | { kind: 'request'; data: FriendRequest }
  | { kind: 'suggestion'; data: Suggestion }
  | { kind: 'friend'; data: Friend };

export default function FriendsScreen() {
  const qc = useQueryClient();
  const friends = useQuery({ queryKey: ['friends'], queryFn: friendsApi.friends });
  const incoming = useQuery({ queryKey: ['requests', 'in'], queryFn: friendsApi.incoming });
  const suggestions = useQuery({ queryKey: ['suggestions'], queryFn: friendsApi.suggestions });

  const refresh = () => qc.invalidateQueries();
  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: refresh,
    onError: (e) => Alert.alert('Error', e instanceof Error ? e.message : 'Something went wrong'),
  });

  const sections = [
    { title: 'Requests', data: (incoming.data ?? []).map((d): Item => ({ kind: 'request', data: d })) },
    { title: 'People you may know', data: (suggestions.data ?? []).map((d): Item => ({ kind: 'suggestion', data: d })) },
    { title: 'Friends', data: (friends.data ?? []).map((d): Item => ({ kind: 'friend', data: d })) },
  ].filter((s) => s.data.length > 0);

  return (
    <SectionList
      sections={sections}
      keyExtractor={(item) => `${item.kind}:${item.data.id}`}
      refreshing={friends.isFetching}
      onRefresh={refresh}
      ListEmptyComponent={<Text style={{ padding: 24 }}>No friends yet. Use Search to find people.</Text>}
      renderSectionHeader={({ section }) => (
        <Text style={{ fontWeight: '700', padding: 12, backgroundColor: '#eee' }}>{section.title}</Text>
      )}
      renderItem={({ item }) => {
        if (item.kind === 'request') {
          const r = item.data;
          return (
            <Row avatar={r.user.avatarUrl} title={nameOf(r.user)} subtitle="wants to be friends">
              <Button title="Accept" onPress={() => run.mutate(() => friendsApi.accept(r.id))} />
              <Button title="Decline" color="gray" onPress={() => run.mutate(() => friendsApi.decline(r.id))} />
            </Row>
          );
        }
        if (item.kind === 'suggestion') {
          const s = item.data;
          return (
            <Row
              avatar={s.avatarUrl}
              title={nameOf(s)}
              subtitle={s.reason === 'mutual' ? `${s.mutualCount} mutual friends` : 'In your contacts'}
            >
              <Button title="Add" onPress={() => run.mutate(() => friendsApi.sendRequest(s.id))} />
              <Button title="✕" color="gray" onPress={() => run.mutate(() => friendsApi.dismiss(s.id))} />
            </Row>
          );
        }
        const f = item.data;
        return (
          <Row avatar={f.avatarUrl} title={`${f.isCloseFriend ? '★ ' : ''}${nameOf(f)}`} subtitle={f.username ? `@${f.username}` : ''}>
            <Button
              title={f.isCloseFriend ? 'Remove close' : 'Close friend'}
              onPress={() =>
                run.mutate(() =>
                  f.isCloseFriend ? friendsApi.removeCloseFriend(f.id) : friendsApi.addCloseFriend(f.id),
                )
              }
            />
            <Button
              title="Unfriend"
              color="crimson"
              onPress={() =>
                Alert.alert('Unfriend', `Remove ${nameOf(f)}?`, [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Unfriend', style: 'destructive', onPress: () => run.mutate(() => friendsApi.unfriend(f.id)) },
                ])
              }
            />
          </Row>
        );
      }}
    />
  );
}

function Row({
  title,
  subtitle,
  avatar,
  children,
}: {
  title: string;
  subtitle?: string;
  avatar?: string | null;
  children: React.ReactNode;
}) {
  return (
    <View style={{ padding: 12, gap: 6, borderBottomWidth: 1, borderColor: '#ddd' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Avatar url={avatar} name={title} />
        <View>
          <Text style={{ fontSize: 16, fontWeight: '600' }}>{title}</Text>
          {!!subtitle && <Text style={{ color: 'gray' }}>{subtitle}</Text>}
        </View>
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>{children}</View>
    </View>
  );
}
