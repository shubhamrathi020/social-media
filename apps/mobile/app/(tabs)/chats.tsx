import { FlatList, Pressable, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Avatar } from '../../src/components/Avatar';
import { useLive } from '../../src/chat/live-state';
import { Conversation, conversationTitle, previewOf } from '../../src/chat/types';
import { api } from '../../src/lib/api';
import { useAuth } from '../../src/state/auth';

export default function ChatsScreen() {
  const router = useRouter();
  const meId = useAuth((s) => s.me!.id);
  const presence = useLive((s) => s.presence);
  const typing = useLive((s) => s.typing);

  const { data, refetch, isFetching } = useQuery({
    queryKey: ['conversations'],
    queryFn: () => api<Conversation[]>('/conversations'),
  });

  return (
    <FlatList<Conversation>
      data={data ?? []}
      keyExtractor={(c) => c.id}
      refreshing={isFetching}
      onRefresh={refetch}
      ListEmptyComponent={
        <Text style={{ padding: 24 }}>No chats yet. Open the Friends tab and tap Message.</Text>
      }
      renderItem={({ item }) => {
        const other = item.type === 'direct' ? item.members.find((m) => m.id !== meId) : undefined;
        const online = other ? presence[other.id]?.online : false;
        const someoneTyping = (typing[item.id] ?? []).some((id) => id !== meId);
        const title = conversationTitle(item, meId);
        return (
          <Pressable
            onPress={() => router.push({ pathname: '/chat/[id]', params: { id: item.id, title } })}
            style={{ flexDirection: 'row', padding: 12, gap: 12, borderBottomWidth: 1, borderColor: '#eee' }}
          >
            <View>
              <Avatar url={other?.avatarUrl} name={title} size={48} />
              {online && (
                <View
                  style={{
                    position: 'absolute', right: 0, bottom: 0, width: 12, height: 12, borderRadius: 6,
                    backgroundColor: '#22c55e', borderWidth: 2, borderColor: 'white',
                  }}
                />
              )}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontWeight: '600', fontSize: 16 }}>{title}</Text>
              <Text numberOfLines={1} style={{ color: someoneTyping ? '#22c55e' : 'gray' }}>
                {someoneTyping ? 'typing…' : previewOf(item.lastMessage)}
              </Text>
            </View>
            {item.unread > 0 && (
              <View
                style={{
                  alignSelf: 'center', minWidth: 22, paddingHorizontal: 6, height: 22, borderRadius: 11,
                  backgroundColor: '#2563eb', alignItems: 'center', justifyContent: 'center',
                }}
              >
                <Text style={{ color: 'white', fontWeight: '700' }}>{item.unread}</Text>
              </View>
            )}
          </Pressable>
        );
      }}
    />
  );
}
