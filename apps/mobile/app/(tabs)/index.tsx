import { useState } from 'react';
import { Button, Text, TextInput, View } from 'react-native';
import { useAuth } from '../../src/state/auth';

export default function Home() {
  const me = useAuth((s) => s.me);
  const updateProfile = useAuth((s) => s.updateProfile);
  const logout = useAuth((s) => s.logout);

  const [username, setUsername] = useState(me?.username ?? '');
  const [displayName, setDisplayName] = useState(me?.displayName ?? '');
  const [message, setMessage] = useState<string | null>(null);

  async function save() {
    setMessage(null);
    try {
      await updateProfile({ username: username || undefined, displayName: displayName || undefined });
      setMessage('Saved');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Could not save');
    }
  }

  return (
    <View style={{ flex: 1, justifyContent: 'center', padding: 24, gap: 12 }}>
      <Text style={{ fontSize: 24, fontWeight: '600' }}>Your profile</Text>
      <Text>{me?.phone}</Text>
      <TextInput
        placeholder="username"
        autoCapitalize="none"
        value={username}
        onChangeText={setUsername}
        style={{ borderWidth: 1, borderRadius: 8, padding: 12 }}
      />
      <TextInput
        placeholder="display name"
        value={displayName}
        onChangeText={setDisplayName}
        style={{ borderWidth: 1, borderRadius: 8, padding: 12 }}
      />
      {message && <Text>{message}</Text>}
      <Button title="Save" onPress={save} />
      <Button title="Log out" color="crimson" onPress={logout} />
    </View>
  );
}
