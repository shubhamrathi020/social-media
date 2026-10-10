import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Button, View } from 'react-native';
import { Text } from '../../src/components/themed';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { LiveJoin, liveApi } from '../../src/lib/live';

// Loaded on demand: the LiveKit/WebRTC native module only exists in a dev build, not in Expo Go.
const loadRoomView = () =>
  (require('../../src/components/LiveRoomView') as typeof import('../../src/components/LiveRoomView')).LiveRoomView;

export default function WatchLive() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [join, setJoin] = useState<LiveJoin | null>(null);
  const [ended, setEnded] = useState(false);

  useEffect(() => {
    liveApi
      .join(id)
      .then(setJoin)
      .catch((e) => {
        Alert.alert('Cannot watch', e instanceof Error ? e.message : '');
        router.back();
      });
  }, [id, router]);

  if (ended) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, backgroundColor: 'black' }}>
        <Stack.Screen options={{ headerShown: false }} />
        <Text style={{ color: 'white', fontSize: 18 }}>This live video has ended</Text>
        <Button title="Close" onPress={() => router.back()} />
      </View>
    );
  }
  if (!join) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: 'black' }}>
        <Stack.Screen options={{ headerShown: false }} />
        <ActivityIndicator color="white" />
      </View>
    );
  }
  const LiveRoomView = loadRoomView();
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <LiveRoomView
        liveId={join.stream.id}
        url={join.url}
        token={join.token}
        isHost={false}
        initialChat={join.recentChat}
        onEnded={() => setEnded(true)}
        onLeave={() => setEnded(true)}
        headerRight={<Button title="✕" color="#555" onPress={() => router.back()} />}
      />
    </>
  );
}
