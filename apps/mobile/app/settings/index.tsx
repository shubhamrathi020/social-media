import { Alert, Appearance, ScrollView, Switch, View, Pressable } from 'react-native';
import { Text } from '../../src/components/themed';
import { Stack, useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Audience, Settings, SettingsPatch, settingsApi } from '../../src/lib/settings';
import { useAuth } from '../../src/state/auth';
import { exportMyData } from '../../src/lib/export';
import { LANGUAGES, useT } from '../../src/i18n';
import { forgetContacts } from '../../src/lib/contacts';

const AUDIENCES: Audience[] = ['everyone', 'friends', 'nobody'];
const AUDIENCE_LABEL: Record<Audience, string> = { everyone: 'Everyone', friends: 'Friends', nobody: 'Nobody' };
const THEMES: Settings['theme'][] = ['system', 'light', 'dark'];

export default function SettingsScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  const logout = useAuth((s) => s.logout);
  const t = useT();

  const { data } = useQuery({ queryKey: ['settings'], queryFn: settingsApi.get });
  const update = useMutation({
    mutationFn: (patch: SettingsPatch) => settingsApi.update(patch),
    onSuccess: (s) => qc.setQueryData(['settings'], s),
    onError: (e) => Alert.alert('Could not save', e instanceof Error ? e.message : ''),
  });

  if (!data) return null;

  const cycle = <T,>(list: T[], current: T) => list[(list.indexOf(current) + 1) % list.length];

  const deleteAccount = () =>
    Alert.alert(
      'Delete account?',
      'Your profile, posts and comments disappear immediately and you are removed from friends and groups. Everything, including photos and messages, is permanently erased within 30 days. This cannot be undone.',
      [
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
      <Stack.Screen options={{ headerShown: true, title: t('Settings') }} />

      <Header text={t('Privacy')} />
      <ChoiceRow
        label={t('Who can message me')}
        value={t(AUDIENCE_LABEL[data.privacy.messages])}
        onPress={() => update.mutate({ privacy: { messages: cycle(AUDIENCES, data.privacy.messages) } })}
      />
      <ChoiceRow
        label={t('Who can see my last seen')}
        value={t(AUDIENCE_LABEL[data.privacy.lastSeen])}
        onPress={() => update.mutate({ privacy: { lastSeen: cycle(AUDIENCES, data.privacy.lastSeen) } })}
      />
      <ChoiceRow
        label={t('Who can see my stories')}
        value={t(AUDIENCE_LABEL[data.privacy.stories])}
        onPress={() => update.mutate({ privacy: { stories: cycle(AUDIENCES, data.privacy.stories) } })}
      />
      <LinkRow label={t('Blocked users')} onPress={() => router.push('/settings/blocked')} />

      <Header text={t('Notifications')} />
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
          label={t(label)}
          value={data.notifications[key]}
          onChange={(v) => update.mutate({ notifications: { [key]: v } })}
        />
      ))}

      <Header text={t('Media')} />
      <SwitchRow label={t('Data saver')} value={data.media.dataSaver} onChange={(v) => update.mutate({ media: { dataSaver: v } })} />
      <SwitchRow label={t('Autoplay videos')} value={data.media.autoplay} onChange={(v) => update.mutate({ media: { autoplay: v } })} />

      <Header text={t('Appearance')} />
      <ChoiceRow
        label={t('Theme')}
        value={t(data.theme[0].toUpperCase() + data.theme.slice(1))}
        onPress={() => {
          const next = cycle(THEMES, data.theme);
          Appearance.setColorScheme?.(next === 'system' ? null : next);
          update.mutate({ theme: next });
        }}
      />

      <ChoiceRow
        label={t('Language')}
        value={LANGUAGES.find((l) => l.code === data.language)?.label ?? 'English'}
        onPress={() => {
          const i = LANGUAGES.findIndex((l) => l.code === data.language);
          update.mutate({ language: LANGUAGES[(i + 1) % LANGUAGES.length].code });
        }}
      />

      <Header text={t('Account')} />
      <LinkRow label={t('Close friends')} onPress={() => router.push('/friends')} />
      <LinkRow label={t('Logged-in devices')} onPress={() => router.push('/settings/sessions')} />
      <LinkRow label={t('Log out')} onPress={logout} />
      <LinkRow
        label={t('Download my data')}
        onPress={() => exportMyData().catch((e) => Alert.alert('Could not export', e instanceof Error ? e.message : ''))}
      />
      <LinkRow
        label={t('Forget my uploaded contacts')}
        onPress={() =>
          forgetContacts()
            .then(() => Alert.alert('Done', 'Your uploaded contacts were deleted.'))
            .catch((e) => Alert.alert('Could not delete', e instanceof Error ? e.message : ''))
        }
      />
      <LinkRow label={t('Delete account')} danger onPress={deleteAccount} />
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
  borderColor: 'rgba(127,127,127,0.25)',
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
      <Text style={{ fontSize: 16, color: danger ? 'crimson' : undefined }}>{label}</Text>
      <Text style={{ color: 'gray' }}>›</Text>
    </Pressable>
  );
}
