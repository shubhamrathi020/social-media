import { useState } from 'react';
import { ActivityIndicator, Alert, Button, Pressable, ScrollView, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Avatar } from '../../src/components/Avatar';
import { FriendPicker } from '../../src/components/FriendPicker';
import { Text, TextInput } from '../../src/components/themed';
import { ChatMember, conversationTitle, isMuted, memberName } from '../../src/chat/types';
import { groupsApi } from '../../src/lib/groups';
import { pickFromLibrary, uploadMedia } from '../../src/lib/media';
import { useAuth } from '../../src/state/auth';
import { useTheme } from '../../src/theme';

const MUTE_OPTIONS: { label: string; hours: number }[] = [
  { label: '8 hours', hours: 8 },
  { label: '1 week', hours: 24 * 7 },
  { label: '1 year', hours: 24 * 365 },
];

/** Conversation details: mute for any chat; members, roles, name and photo for groups. */
export default function ConversationInfo() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const c = useTheme();
  const meId = useAuth((s) => s.me!.id);

  const { data: conv, isLoading, refetch } = useQuery({ queryKey: ['conversation', id], queryFn: () => groupsApi.get(id) });
  const [title, setTitle] = useState<string | null>(null);
  const [adding, setAdding] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  if (isLoading) return <ActivityIndicator style={{ marginTop: 40 }} />;
  if (!conv) {
    return (
      <View style={{ padding: 24 }}>
        <Stack.Screen options={{ headerShown: true, title: 'Info' }} />
        <Text>This conversation is no longer available.</Text>
      </View>
    );
  }

  const isGroup = conv.type === 'group';
  const amAdmin = conv.myRole === 'admin';

  const run = async (fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    try {
      await fn();
      await Promise.all([refetch(), qc.invalidateQueries({ queryKey: ['conversations'] })]);
      after?.();
    } catch (e) {
      Alert.alert('Something went wrong', e instanceof Error ? e.message : '');
    } finally {
      setBusy(false);
    }
  };

  const memberActions = (m: ChatMember) => {
    const buttons: Parameters<typeof Alert.alert>[2] = [
      m.role === 'admin'
        ? { text: 'Remove as admin', onPress: () => run(() => groupsApi.setRole(id, m.id, 'member')) }
        : { text: 'Make admin', onPress: () => run(() => groupsApi.setRole(id, m.id, 'admin')) },
      {
        text: 'Remove from group',
        style: 'destructive',
        onPress: () => run(() => groupsApi.remove(id, m.id)),
      },
      { text: 'Cancel', style: 'cancel' },
    ];
    Alert.alert(memberName(m), undefined, buttons);
  };

  const changePhoto = async () => {
    const file = await pickFromLibrary(['image']).catch(() => null);
    if (!file) return;
    run(async () => {
      const media = await uploadMedia(file, 'avatar');
      await groupsApi.setPhoto(id, media.id);
    });
  };

  const muted = isMuted(conv);
  const mute = () =>
    Alert.alert('Mute notifications', undefined, [
      ...MUTE_OPTIONS.map((o) => ({
        text: o.label,
        onPress: () => run(() => groupsApi.mute(id, new Date(Date.now() + o.hours * 3600e3).toISOString())),
      })),
      { text: 'Cancel', style: 'cancel' as const },
    ]);

  const leave = () =>
    Alert.alert('Leave group?', 'You will stop receiving messages and lose access to the history.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Leave',
        style: 'destructive',
        onPress: () =>
          run(
            () => groupsApi.leave(id),
            () => {
              qc.removeQueries({ queryKey: ['messages', id] });
              router.dismissAll();
            },
          ),
      },
    ]);

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
      <Stack.Screen options={{ headerShown: true, title: isGroup ? 'Group info' : 'Chat info' }} />

      <View style={{ alignItems: 'center', gap: 8 }}>
        <Avatar url={isGroup ? conv.avatarUrl : conv.members.find((m) => m.id !== meId)?.avatarUrl} name={conversationTitle(conv, meId)} size={88} />
        {isGroup && amAdmin && <Button title="Change photo" onPress={changePhoto} disabled={busy} />}
      </View>

      {isGroup && amAdmin ? (
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <TextInput
            value={title ?? conv.title ?? ''}
            onChangeText={setTitle}
            maxLength={60}
            accessibilityLabel="Group name"
            style={{ flex: 1, borderWidth: 1, borderRadius: 8, padding: 10 }}
          />
          <Button
            title="Save"
            disabled={busy || !title || title.trim() === conv.title}
            onPress={() => run(() => groupsApi.rename(id, title!.trim()), () => setTitle(null))}
          />
        </View>
      ) : (
        <Text style={{ fontSize: 22, fontWeight: '700', textAlign: 'center' }}>{conversationTitle(conv, meId)}</Text>
      )}

      <Button
        title={muted ? `Unmute (muted until ${new Date(conv.mutedUntil!).toLocaleString()})` : 'Mute notifications'}
        onPress={muted ? () => run(() => groupsApi.mute(id, null)) : mute}
        disabled={busy}
      />

      {isGroup && (
        <View style={{ gap: 4 }}>
          <Text accessibilityRole="header" style={{ fontWeight: '700', color: c.muted }}>
            {conv.members.length} MEMBERS
          </Text>
          {conv.members.map((m) => (
            <Pressable
              key={m.id}
              disabled={!amAdmin || m.id === meId}
              onPress={() => memberActions(m)}
              accessibilityRole="button"
              accessibilityLabel={`${memberName(m)}${m.role === 'admin' ? ', admin' : ''}`}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 }}
            >
              <Avatar url={m.avatarUrl} name={memberName(m)} size={36} />
              <Text style={{ flex: 1, fontSize: 16 }}>{m.id === meId ? 'You' : memberName(m)}</Text>
              {m.role === 'admin' && <Text style={{ color: c.primary, fontSize: 12 }}>Admin</Text>}
            </Pressable>
          ))}

          {amAdmin &&
            (adding === null ? (
              <Button title="Add people" onPress={() => setAdding([])} disabled={busy} />
            ) : (
              <View style={{ borderTopWidth: 1, borderColor: c.border, paddingTop: 8 }}>
                <FriendPicker selected={adding} onChange={setAdding} exclude={conv.members.map((m) => m.id)} />
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Button title="Cancel" onPress={() => setAdding(null)} />
                  <Button
                    title={`Add ${adding.length || ''}`.trim()}
                    disabled={busy || adding.length === 0}
                    onPress={() => run(() => groupsApi.addMembers(id, adding), () => setAdding(null))}
                  />
                </View>
              </View>
            ))}

          <View style={{ marginTop: 16 }}>
            <Button title="Leave group" color={c.danger} onPress={leave} disabled={busy} />
          </View>
        </View>
      )}
    </ScrollView>
  );
}
