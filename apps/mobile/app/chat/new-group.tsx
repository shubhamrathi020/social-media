import { useState } from 'react';
import { Alert, Button, ScrollView } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { FriendPicker } from '../../src/components/FriendPicker';
import { Text, TextInput } from '../../src/components/themed';
import { groupsApi } from '../../src/lib/groups';
import { useTheme } from '../../src/theme';

export default function NewGroup() {
  const router = useRouter();
  const qc = useQueryClient();
  const c = useTheme();
  const [title, setTitle] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      const g = await groupsApi.create(title.trim(), members);
      await qc.invalidateQueries({ queryKey: ['conversations'] });
      router.replace({ pathname: '/chat/[id]', params: { id: g.id, title: g.title ?? 'Group' } });
    } catch (e) {
      Alert.alert('Could not create group', e instanceof Error ? e.message : '');
    } finally {
      setBusy(false);
    }
  }

  const ready = title.trim().length > 0 && members.length >= 2;
  return (
    <ScrollView contentContainerStyle={{ paddingVertical: 12 }}>
      <Stack.Screen options={{ headerShown: true, title: 'New group' }} />
      <TextInput
        value={title}
        onChangeText={setTitle}
        placeholder="Group name"
        maxLength={60}
        accessibilityLabel="Group name"
        style={{ borderWidth: 1, borderRadius: 8, padding: 12, marginHorizontal: 12 }}
      />
      <Text style={{ color: c.muted, padding: 12 }}>
        Pick at least two friends ({members.length} selected)
      </Text>
      <FriendPicker selected={members} onChange={setMembers} />
      <Button title={busy ? 'Creating…' : 'Create group'} onPress={create} disabled={!ready || busy} />
    </ScrollView>
  );
}
