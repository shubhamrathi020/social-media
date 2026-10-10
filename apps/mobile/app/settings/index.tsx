import { Alert, Appearance, ScrollView, Switch, Text, View, Pressable } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Audience, Settings, SettingsPatch, settingsApi } from '../../src/lib/settings';
import { useAuth } from '../../src/state/auth';

const AUDIENCES: Audience[] = ['everyone', 'friends', 'nobody'];
const AUDIENCE_LABEL: Record<Audience, string> = { everyone: 'Everyone', friends: 'Friends', nobody: 'Nobody' };
const THEMES: Settings['theme'][] = ['system', 'light', 'dark'];

export default function SettingsScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  const logout = useAuth((s) => s.logout);

  const { data } = useQuery({ queryKey: ['settings'], queryFn: settingsApi.get });
  const update = useMutation({
    mutationFn: (patch: SettingsPatch) => settingsApi.update(patch),
    onSuccess: (s) => qc.setQueryData(['settings'], s),
    onError: (e) => Alert.alert('Could not save', e instanceof Error ? e.message : ''),
  });

  if (!data) return null;

  const cycle = <T,>(list: T[], current: T) => list[(list.indexOf(current) + 1) % list.length];

  const deleteAccount = () =>
    Alert.alert('Delete account?', 'Your profile is removed immediately and cannot be recovered.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await settingsApi.deleteAccount();
            await logout();
          } catch (e) {
            Alert.alert('Could not delete', e instanceof Error ? e.message : '');
          }
        },
      },
    ]);

  return (
    <ScrollView>
      <Stack.Screen options={{ headerShown: true, title: 'Settings' }} />

      <Header text="Privacy" />
      <ChoiceRow
        label="Who can message me"
        value={AUDIENCE_LABEL[data.privacy.messages]}
        onPress={() => update.mutate({ privacy: { messages: cycle(AUDIENCES, data.privacy.messages) } })}
      />
      <ChoiceRow
        label="Who can see my last seen"
        value={AUDIENCE_LABEL[data.privacy.lastSeen]}
        onPress={() => update.mutate({ privacy: { lastSeen: cycle(AUDIENCES, data.privacy.lastSeen) } })}
      />
      <ChoiceRow
        label="Who can see my stories"
        value={AUDIENCE_LABEL[data.privacy.stories]}
        onPress={() => update.mutate({ privacy: { stories: cycle(AUDIENCES, data.privacy.stories) } })}
      />
      <LinkRow label="Blocked users" onPress={() => router.push('/settings/blocked')} />

      <Header text="Notifications" />
      {(
        [
          ['messages', 'Messages'],
          ['friendRequests', 'Friend requests'],
          ['likes', 'Likes'],
          ['comments', 'Comments and replies'],
          ['live', 'Live videos'],
        ] as const
      ).map(([key, label]) => (
        <SwitchRow
          key={key}
          label={label}
          value={data.notifications[key]}
          onChange={(v) => update.mutate({ notifications: { [key]: v } })}
        />
      ))}

      <Header text="Media" />
      <SwitchRow label="Data saver" value={data.media.dataSaver} onChange={(v) => update.mutate({ media: { dataSaver: v } })} />
      <SwitchRow label="Autoplay videos" value={data.media.autoplay} onChange={(v) => update.mutate({ media: { autoplay: v } })} />

      <Header text="Appearance" />
      <ChoiceRow
        label="Theme"
        value={data.theme[0].toUpperCase() + data.theme.slice(1)}
        onPress={() => {
          const next = cycle(THEMES, data.theme);
          Appearance.setColorScheme(next === 'system' ? null : next);
          update.mutate({ theme: next });
        }}
      />

      <Header text="Account" />
      <LinkRow label="Close friends" onPress={() => router.push('/friends')} />
      <LinkRow label="Logged-in devices" onPress={() => router.push('/settings/sessions')} />
      <LinkRow label="Log out" onPress={logout} />
      <LinkRow label="Delete account" danger onPress={deleteAccount} />
      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const Header = ({ text }: { text: string }) => (
  <Text style={{ fontWeight: '700', paddingHorizontal: 16, paddingTop: 22, paddingBottom: 6, color: 'gray' }}>
    {text.toUpperCase()}
  </Text>
);

const rowStyle = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  justifyContent: 'space-between' as const,
  paddingHorizontal: 16,
  paddingVertical: 12,
  borderBottomWidth: 1,
  borderColor: '#eee',
};

function ChoiceRow({ label, value, onPress }: { label: string; value: string; onPress: () => void }) {
  return (
    <Pressable style={rowStyle} onPress={onPress}>
      <Text style={{ fontSize: 16 }}>{label}</Text>
      <Text style={{ color: '#2563eb', fontWeight: '600' }}>{value}</Text>
    </Pressable>
  );
}

function SwitchRow({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={rowStyle}>
      <Text style={{ fontSize: 16 }}>{label}</Text>
      <Switch value={value} onValueChange={onChange} />
    </View>
  );
}

function LinkRow({ label, onPress, danger }: { label: string; onPress: () => void; danger?: boolean }) {
  return (
    <Pressable style={rowStyle} onPress={onPress}>
      <Text style={{ fontSize: 16, color: danger ? 'crimson' : 'black' }}>{label}</Text>
      <Text style={{ color: 'gray' }}>›</Text>
    </Pressable>
  );
}
