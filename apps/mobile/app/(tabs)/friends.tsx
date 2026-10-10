import { Alert, Button, SectionList, View } from 'react-native';
import { Text } from '../../src/components/themed';
import { useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, json } from '../../src/lib/api';
import { Avatar } from '../../src/components/Avatar';
import { syncContacts } from '../../src/lib/contacts';
import { useAuth } from '../../src/state/auth';
import { useTheme } from '../../src/theme';
import { Friend, FriendRequest, Suggestion, friendsApi, nameOf } from '../../src/lib/friends';

type Item =
  | { kind: 'request'; data: FriendRequest }
  | { kind: 'suggestion'; data: Suggestion }
  | { kind: 'friend'; data: Friend };

export default function FriendsScreen() {
  const qc = useQueryClient();
  const router = useRouter();
  const c = useTheme();
  const friends = useQuery({ queryKey: ['friends'], queryFn: friendsApi.friends });
  const incoming = useQuery({ queryKey: ['requests', 'in'], queryFn: friendsApi.incoming });
  const suggestions = useQuery({ queryKey: ['suggestions'], queryFn: friendsApi.suggestions });
  const myPhone = useAuth((s) => s.me?.phone ?? '');

  const findFromContacts = () =>
    Alert.alert(
      'Find friends from contacts',
      'Your contacts\' phone numbers are sent securely to match people who use the app. The numbers are not stored; only a keyed fingerprint is kept so new matches can be suggested later.',
      [
        { text: 'Not now', style: 'cancel' },
        {
          text: 'Continue',
          onPress: async () => {
            try {
              const r = await syncContacts(myPhone);
              if (!r) return Alert.alert('Contacts access was not allowed');
              await qc.invalidateQueries({ queryKey: ['suggestions'] });
              Alert.alert('Done', r.matched ? `${r.matched} of your contacts use the app.` : 'None of your contacts use the app yet.');
            } catch (e) {
              Alert.alert('Could not read contacts', e instanceof Error ? e.message : '');
            }
          },
        },
      ],
    );

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
      ListHeaderComponent={
        <View style={{ padding: 10 }}>
          <Button title="Find friends from contacts" onPress={findFromContacts} />
        </View>
      }
      ListEmptyComponent={<Text style={{ padding: 24 }}>No friends yet. Use Search to find people.</Text>}
      renderSectionHeader={({ section }) => (
        <Text accessibilityRole="header" style={{ fontWeight: '700', padding: 12, backgroundColor: c.subtle }}>{section.title}</Text>
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
              title="Message"
              onPress={async () => {
                try {
                  const c = await api<{ id: string }>('/conversations', json({ userId: f.id }));
                  router.push({ pathname: '/chat/[id]', params: { id: c.id, title: nameOf(f) } });
                } catch (e) {
                  Alert.alert('Cannot message', e instanceof Error ? e.message : '');
                }
              }}
            />
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
    <View style={{ padding: 12, gap: 6, borderBottomWidth: 1, borderColor: useTheme().border }}>
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
