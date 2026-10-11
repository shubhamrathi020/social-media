import { Alert, Button, FlatList, View } from 'react-native';
import { Text } from '../../src/components/themed';
import { Stack } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { settingsApi } from '../../src/lib/settings';

export default function Sessions() {
  const qc = useQueryClient();
  const { data = [] } = useQuery({ queryKey: ['sessions'], queryFn: settingsApi.sessions });

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ headerShown: true, title: 'Logged-in devices' }} />
      <FlatList
        data={data}
        keyExtractor={(s) => s.id}
        renderItem={({ item }) => (
          <View style={{ padding: 14, gap: 4, borderBottomWidth: 1, borderColor: 'rgba(127,127,127,0.25)' }}>
            <Text style={{ fontWeight: '600', fontSize: 16 }}>
              {item.platform}
              {item.current ? '  ·  this device' : ''}
            </Text>
            <Text style={{ color: 'gray' }}>
              Signed in {new Date(item.createdAt).toLocaleDateString()} · active{' '}
              {new Date(item.lastUsedAt).toLocaleString()}
            </Text>
            {!item.current && (
              <Button
                title="Log out this device"
                color="crimson"
                onPress={async () => {
                  try {
                    await settingsApi.revokeSession(item.id);
                    qc.invalidateQueries({ queryKey: ['sessions'] });
                  } catch (e) {
                    Alert.alert('Could not log out', e instanceof Error ? e.message : '');
                  }
                }}
              />
            )}
          </View>
        )}
      />
    </View>
  );
}
