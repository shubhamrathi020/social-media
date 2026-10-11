import { useEffect, useRef, useState } from 'react';
import { t } from '../../src/i18n';
import { Alert, Button, View } from 'react-native';
import { Text, TextInput } from '../../src/components/themed';
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
      Alert.alert(t('Could not go live'), e instanceof Error ? e.message : '');
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
          headerRight={<Button title={t('End')} color="#dc2626" onPress={end} />}
        />
      </>
    );
  }

  return (
    <View style={{ flex: 1, padding: 16, gap: 12, justifyContent: 'center' }}>
      <Stack.Screen options={{ headerShown: true, title: t('Go live') }} />
      <TextInput
        value={title}
        onChangeText={setTitle}
        placeholder={t('Add a title')}
        maxLength={100}
        style={{ borderWidth: 1, borderRadius: 8, padding: 12 }}
      />
      <Button
        title={closeOnly ? t('★ Close friends only (tap to change)') : t('All friends (tap for close friends only)')}
        onPress={() => setCloseOnly((v) => !v)}
      />
      <Text style={{ color: 'gray' }}>{t('Your camera and microphone start when you go live.')}</Text>
      <Button title={busy ? t('Starting…') : t('Go live')} onPress={goLive} disabled={busy} />
    </View>
  );
}
