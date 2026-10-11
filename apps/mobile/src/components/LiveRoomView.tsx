import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import { FlatList, Pressable, View } from 'react-native';
import { Text, TextInput } from './themed';
import {
  AudioSession,
  LiveKitRoom,
  VideoTrack,
  isTrackReference,
  registerGlobals,
  useTracks,
} from '@livekit/react-native';
import { Track } from 'livekit-client';
import { connectSocket, emitAck } from '../chat/socket';
import { LiveChatMessage } from '../lib/live';

// Installs the WebRTC globals LiveKit needs. Safe to call more than once.
registerGlobals();

function Stage() {
  const refs = useTracks([Track.Source.Camera]);
  const first = refs.find(isTrackReference);
  if (!first) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: 'white' }}>{t('Waiting for video…')}</Text>
      </View>
    );
  }
  return <VideoTrack trackRef={first} style={{ flex: 1 }} objectFit="cover" />;
}

interface Props {
  liveId: string;
  url: string;
  token: string;
  isHost: boolean;
  initialChat: LiveChatMessage[];
  onEnded: () => void;
  onLeave: () => void;
  headerRight?: React.ReactNode;
}

/** Video stage plus live chat, hearts and viewer count. Used by both the host and viewers. */
export function LiveRoomView({ liveId, url, token, isHost, initialChat, onEnded, onLeave, headerRight }: Props) {
  const [chat, setChat] = useState<LiveChatMessage[]>(initialChat);
  const [viewers, setViewers] = useState(0);
  const [hearts, setHearts] = useState(0);
  const [text, setText] = useState('');
  const endedRef = useRef(onEnded);
  endedRef.current = onEnded;

  useEffect(() => {
    AudioSession.startAudioSession();
    return () => void AudioSession.stopAudioSession();
  }, []);

  useEffect(() => {
    const s = connectSocket();
    emitAck<{ viewerCount: number }>('live:join', { liveId }).then((r) => r.ok && setViewers(r.data.viewerCount));
    const onChat = (m: LiveChatMessage) => m.liveId === liveId && setChat((c) => [...c.slice(-99), m]);
    const onHeart = (p: { liveId: string; total: number }) => p.liveId === liveId && setHearts(p.total);
    const onViewers = (p: { liveId: string; count: number }) => p.liveId === liveId && setViewers(p.count);
    const onEndedEvt = (p: { liveId: string }) => p.liveId === liveId && endedRef.current();
    s.on('live:chat', onChat);
    s.on('live:heart', onHeart);
    s.on('live:viewers', onViewers);
    s.on('live:ended', onEndedEvt);
    return () => {
      s.off('live:chat', onChat);
      s.off('live:heart', onHeart);
      s.off('live:viewers', onViewers);
      s.off('live:ended', onEndedEvt);
      emitAck('live:leave', { liveId });
    };
  }, [liveId]);

  function send() {
    const t = text.trim();
    if (!t) return;
    setText('');
    emitAck('live:chat', { liveId, text: t });
  }

  return (
    <View style={{ flex: 1, backgroundColor: 'black' }}>
      <View style={{ flex: 1 }}>
        <LiveKitRoom
          serverUrl={url}
          token={token}
          connect
          audio={isHost}
          video={isHost}
          options={{ adaptiveStream: true, dynacast: true }}
          onDisconnected={onLeave}
        >
          <Stage />
        </LiveKitRoom>
      </View>

      <View style={{ position: 'absolute', top: 48, left: 12, right: 12, flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={{ color: 'white', fontWeight: '700', backgroundColor: '#dc2626', paddingHorizontal: 8, borderRadius: 4 }}>
          {t('LIVE · 👁 {v} · ❤️ {h}', { v: viewers, h: hearts })}
        </Text>
        {headerRight}
      </View>

      <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '45%' }}>
        <FlatList
          data={chat}
          keyExtractor={(m) => m.id}
          style={{ paddingHorizontal: 12 }}
          renderItem={({ item }) => (
            <Text style={{ color: 'white', marginVertical: 2 }}>
              <Text style={{ fontWeight: '700' }}>{item.author.displayName ?? item.author.username} </Text>
              {item.text}
            </Text>
          )}
        />
        <View style={{ flexDirection: 'row', gap: 8, padding: 10, alignItems: 'center' }}>
          <TextInput
            value={text}
            onChangeText={setText}
            onSubmitEditing={send}
            placeholder={t('Say something…')}
            placeholderTextColor="#ccc"
            maxLength={200}
            returnKeyType="send"
            style={{ flex: 1, color: 'white', borderWidth: 1, borderColor: '#888', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8 }}
          />
          {!isHost && (
            <Pressable onPress={() => emitAck('live:heart', { liveId })} accessibilityRole="button" accessibilityLabel={t('Send a heart')}>
              <Text style={{ fontSize: 28 }}>❤️</Text>
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
}
