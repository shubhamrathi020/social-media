import { Alert, Button, FlatList, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Avatar } from '../../src/components/Avatar';
import { settingsApi } from '../../src/lib/settings';

export default function Blocked() {
  const qc = useQueryClient();
  const { data = [], isLoading } = useQuery({ queryKey: ['blocked'], queryFn: settingsApi.blocked });

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ headerShown: true, title: 'Blocked users' }} />
      <FlatList
        data={data}
        keyExtractor={(u) => u.id}
        ListEmptyComponent={
          isLoading ? null : <Text style={{ padding: 24, color: 'gray' }}>You have not blocked anyone.</Text>
        }
        renderItem={({ item }) => (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12 }}>
            <Avatar url={item.avatarUrl} name={item.displayName ?? item.username} />
            <Text style={{ flex: 1, fontWeight: '600' }}>{item.displayName ?? item.username}</Text>
            <Button
              title="Unblock"
              onPress={async () => {
                try {
                  await settingsApi.unblock(item.id);
                  qc.invalidateQueries({ queryKey: ['blocked'] });
                } catch (e) {
                  Alert.alert('Could not unblock', e instanceof Error ? e.message : '');
                }
              }}
            />
          </View>
        )}
      />
    </View>
  );
}
