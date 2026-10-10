import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Text, TextInput, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { liveApi } from '../../src/lib/live';

// Loaded on demand: the LiveKit/WebRTC native module only exists in a dev build, not in Expo Go.
const loadRoomView = () =>
  (require('../../src/components/LiveRoomView') as typeof import('../../src/components/LiveRoomView')).LiveRoomView;

interface Session {
  id: string;
  url: string;
  token: string;
}

export default function GoLive() {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [closeOnly, setCloseOnly] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);
  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;

  // Never leave a stream running if the host navigates away.
  useEffect(() => {
    return () => {
      if (sessionRef.current) liveApi.end(sessionRef.current.id).catch(() => undefined);
    };
  }, []);

  async function goLive() {
    setBusy(true);
    try {
      const s = await liveApi.create(title.trim(), closeOnly ? 'close_friends' : 'friends');
      setSession({ id: s.id, url: s.url, token: s.token });
      // Friends are notified once the host's camera is publishing; the room view connects on mount.
      setTimeout(() => liveApi.start(s.id).catch(() => undefined), 2500);
    } catch (e) {
      Alert.alert('Could not go live', e instanceof Error ? e.message : '');
    } finally {
      setBusy(false);
    }
  }

  async function end() {
    if (!session) return;
    await liveApi.end(session.id).catch(() => undefined);
    setSession(null);
    router.back();
  }

  if (session) {
    const LiveRoomView = loadRoomView();
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <LiveRoomView
          liveId={session.id}
          url={session.url}
          token={session.token}
          isHost
          initialChat={[]}
          onEnded={() => router.back()}
          onLeave={() => undefined}
          headerRight={<Button title="End" color="#dc2626" onPress={end} />}
        />
      </>
    );
  }

  return (
    <View style={{ flex: 1, padding: 16, gap: 12, justifyContent: 'center' }}>
      <Stack.Screen options={{ headerShown: true, title: 'Go live' }} />
      <TextInput
        value={title}
        onChangeText={setTitle}
        placeholder="Add a title"
        maxLength={100}
        style={{ borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 12 }}
      />
      <Button
        title={closeOnly ? '★ Close friends only (tap to change)' : 'All friends (tap for close friends only)'}
        onPress={() => setCloseOnly((v) => !v)}
      />
      <Text style={{ color: 'gray' }}>Your camera and microphone start when you go live.</Text>
      <Button title={busy ? 'Starting…' : 'Go live'} onPress={goLive} disabled={busy} />
    </View>
  );
}
