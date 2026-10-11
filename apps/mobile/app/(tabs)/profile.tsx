import { useState } from 'react';
import { t } from '../../src/i18n';
import { Button, View } from 'react-native';
import { Text, TextInput } from '../../src/components/themed';
import { useRouter } from 'expo-router';
import { Avatar } from '../../src/components/Avatar';
import { pickFromLibrary, uploadMedia } from '../../src/lib/media';
import { useAuth } from '../../src/state/auth';

export default function Home() {
  const me = useAuth((s) => s.me);
  const updateProfile = useAuth((s) => s.updateProfile);
  const logout = useAuth((s) => s.logout);
  const router = useRouter();

  const [username, setUsername] = useState(me?.username ?? '');
  const [displayName, setDisplayName] = useState(me?.displayName ?? '');
  const [message, setMessage] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);

  async function changePhoto() {
    setMessage(null);
    try {
      const file = await pickFromLibrary(['image']);
      if (!file) return;
      setProgress(0);
      const media = await uploadMedia(file, 'avatar', setProgress);
      await updateProfile({ avatarMediaId: media.id });
    } catch (e) {
      setMessage(e instanceof Error ? e.message : t('Could not update photo'));
    } finally {
      setProgress(null);
    }
  }

  async function save() {
    setMessage(null);
    try {
      await updateProfile({ username: username || undefined, displayName: displayName || undefined });
      setMessage(t('Saved'));
    } catch (e) {
      setMessage(e instanceof Error ? e.message : t('Could not save'));
    }
  }

  return (
    <View style={{ flex: 1, justifyContent: 'center', padding: 24, gap: 12 }}>
      <View style={{ alignItems: 'center', gap: 8 }}>
        <Avatar url={me?.avatarUrl} name={me?.displayName ?? me?.username} size={96} />
        <Button
          title={progress === null ? t('Change photo') : t('Uploading {p}%', { p: Math.round(progress * 100) })}
          onPress={changePhoto}
          disabled={progress !== null}
        />
      </View>
      <Text style={{ fontSize: 24, fontWeight: '600' }}>{t('Your profile')}</Text>
      <Text>{me?.phone}</Text>
      <TextInput
        placeholder={t('username')}
        autoCapitalize="none"
        value={username}
        onChangeText={setUsername}
        style={{ borderWidth: 1, borderRadius: 8, padding: 12 }}
      />
      <TextInput
        placeholder={t('display name')}
        value={displayName}
        onChangeText={setDisplayName}
        style={{ borderWidth: 1, borderRadius: 8, padding: 12 }}
      />
      {message && <Text>{message}</Text>}
      <Button title={t('Save')} onPress={save} />
      <Button title={t('Settings')} onPress={() => router.push('/settings')} />
      <Button title={t('Log out')} color="crimson" onPress={logout} />
    </View>
  );
}
