import { Alert, Button, SectionList, View } from 'react-native';
import { t } from '../../src/i18n';
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
    Alert.alert(t('Find friends from contacts'), t('Your contacts\' phone numbers are sent securely to match people who use the app. The numbers are not stored; only a keyed fingerprint is kept so new matches can be suggested later.'),
      [
        { text: t('Not now'), style: 'cancel' },
        {
          text: t('Continue'),
          onPress: async () => {
            try {
              const r = await syncContacts(myPhone);
              if (!r) return Alert.alert(t('Contacts access was not allowed'));
              await qc.invalidateQueries({ queryKey: ['suggestions'] });
              Alert.alert(t('Done'), r.matched ? t('{n} of your contacts use the app.', { n: r.matched }) : t('None of your contacts use the app yet.'));
            } catch (e) {
              Alert.alert(t('Could not read contacts'), e instanceof Error ? e.message : '');
            }
          },
        },
      ],
    );

  const refresh = () => qc.invalidateQueries();
  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: refresh,
    onError: (e) => Alert.alert(t('Error'), e instanceof Error ? e.message : 'Something went wrong'),
  });

  const sections = [
    { title: t('Requests'), data: (incoming.data ?? []).map((d): Item => ({ kind: 'request', data: d })) },
    { title: t('People you may know'), data: (suggestions.data ?? []).map((d): Item => ({ kind: 'suggestion', data: d })) },
    { title: t('Friends'), data: (friends.data ?? []).map((d): Item => ({ kind: 'friend', data: d })) },
  ].filter((s) => s.data.length > 0);

  return (
    <SectionList
      sections={sections}
      keyExtractor={(item) => `${item.kind}:${item.data.id}`}
      refreshing={friends.isFetching}
      onRefresh={refresh}
      ListHeaderComponent={
        <View style={{ padding: 10 }}>
          <Button title={t('Find friends from contacts')} onPress={findFromContacts} />
        </View>
      }
      ListEmptyComponent={<Text style={{ padding: 24 }}>{t('No friends yet. Use Search to find people.')}</Text>}
      renderSectionHeader={({ section }) => (
        <Text accessibilityRole="header" style={{ fontWeight: '700', padding: 12, backgroundColor: c.subtle }}>{section.title}</Text>
      )}
      renderItem={({ item }) => {
        if (item.kind === 'request') {
          const r = item.data;
          return (
            <Row avatar={r.user.avatarUrl} title={nameOf(r.user)} subtitle={t('wants to be friends')}>
              <Button title={t('Accept')} onPress={() => run.mutate(() => friendsApi.accept(r.id))} />
              <Button title={t('Decline')} color="gray" onPress={() => run.mutate(() => friendsApi.decline(r.id))} />
            </Row>
          );
        }
        if (item.kind === 'suggestion') {
          const s = item.data;
          return (
            <Row
              avatar={s.avatarUrl}
              title={nameOf(s)}
              subtitle={s.reason === 'mutual' ? t('{n} mutual friends', { n: s.mutualCount }) : t('In your contacts')}
            >
              <Button title={t('Add')} onPress={() => run.mutate(() => friendsApi.sendRequest(s.id))} />
              <Button title="✕" color="gray" onPress={() => run.mutate(() => friendsApi.dismiss(s.id))} />
            </Row>
          );
        }
        const f = item.data;
        return (
          <Row avatar={f.avatarUrl} title={`${f.isCloseFriend ? '★ ' : ''}${nameOf(f)}`} subtitle={f.username ? `@${f.username}` : ''}>
            <Button
              title={t('Message')}
              onPress={async () => {
                try {
                  const c = await api<{ id: string }>('/conversations', json({ userId: f.id }));
                  router.push({ pathname: '/chat/[id]', params: { id: c.id, title: nameOf(f) } });
                } catch (e) {
                  Alert.alert(t('Cannot message'), e instanceof Error ? e.message : '');
                }
              }}
            />
            <Button
              title={f.isCloseFriend ? t('Remove close') : t('Close friend')}
              onPress={() =>
                run.mutate(() =>
                  f.isCloseFriend ? friendsApi.removeCloseFriend(f.id) : friendsApi.addCloseFriend(f.id),
                )
              }
            />
            <Button
              title={t('Unfriend')}
              color="crimson"
              onPress={() =>
                Alert.alert(t('Unfriend'), t('Remove {name}?', { name: nameOf(f) }), [
                  { text: t('Cancel'), style: 'cancel' },
                  { text: t('Unfriend'), style: 'destructive', onPress: () => run.mutate(() => friendsApi.unfriend(f.id)) },
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
