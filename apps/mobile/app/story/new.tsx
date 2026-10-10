import { useState } from 'react';
import { Alert, Button, Image, ScrollView, Text, TextInput, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { PickedFile, pickFromLibrary, uploadMedia } from '../../src/lib/media';
import { StoryKind, storiesApi } from '../../src/lib/stories';

const COLOURS = ['#2563eb', '#db2777', '#059669', '#d97706', '#7c3aed', '#111827'];

export default function NewStory() {
  const { kind } = useLocalSearchParams<{ kind: StoryKind }>();
  const router = useRouter();
  const qc = useQueryClient();
  const isStatus = kind === 'status';

  const [file, setFile] = useState<PickedFile | null>(null);
  const [text, setText] = useState('');
  const [background, setBackground] = useState(COLOURS[0]);
  const [closeOnly, setCloseOnly] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  async function choose() {
    try {
      const f = await pickFromLibrary(['image', 'video']);
      if (f) setFile(f);
    } catch (e) {
      Alert.alert('Cannot open library', e instanceof Error ? e.message : '');
    }
  }

  async function publish() {
    try {
      const audience = closeOnly ? 'close_friends' : 'friends';
      let mediaId: string | undefined;
      if (file) {
        setBusy('Uploading…');
        mediaId = (await uploadMedia(file, kind, (p) => setBusy(`Uploading… ${Math.round(p * 100)}%`))).id;
      }
      setBusy('Publishing…');
      if (isStatus) {
        await storiesApi.createStatus({ mediaId, text: text.trim() || undefined, background: mediaId ? undefined : background, audience });
      } else {
        await storiesApi.createStory({ mediaId: mediaId!, text: text.trim() || undefined, audience });
      }
      await qc.invalidateQueries({ queryKey: ['stories', kind] });
      router.back();
    } catch (e) {
      Alert.alert('Could not publish', e instanceof Error ? e.message : '');
    } finally {
      setBusy(null);
    }
  }

  const canPublish = isStatus ? !!file || !!text.trim() : !!file;
  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Stack.Screen options={{ headerShown: true, title: isStatus ? 'New status' : 'New story' }} />
      {file ? (
        <View style={{ alignItems: 'center', gap: 8 }}>
          <Image source={{ uri: file.uri }} style={{ width: 180, height: 320, borderRadius: 12, backgroundColor: '#ddd' }} />
          <Button title="Remove" onPress={() => setFile(null)} disabled={!!busy} />
        </View>
      ) : (
        isStatus && (
          <View style={{ backgroundColor: background, borderRadius: 12, height: 220, justifyContent: 'center', padding: 16 }}>
            <Text style={{ color: 'white', fontSize: 22, fontWeight: '700', textAlign: 'center' }}>
              {text || 'Type a status…'}
            </Text>
          </View>
        )
      )}
      <Button title={file ? 'Change photo / video' : 'Choose photo / video'} onPress={choose} disabled={!!busy} />

      <TextInput
        value={text}
        onChangeText={setText}
        placeholder={isStatus ? 'Status text' : 'Caption (optional)'}
        multiline
        maxLength={700}
        style={{ borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 12, minHeight: 60 }}
      />
      {isStatus && !file && (
        <View style={{ flexDirection: 'row', gap: 10 }}>
          {COLOURS.map((c) => (
            <Text
              key={c}
              onPress={() => setBackground(c)}
              style={{
                width: 32, height: 32, borderRadius: 16, backgroundColor: c, textAlign: 'center',
                color: 'white', lineHeight: 32, overflow: 'hidden',
              }}
            >
              {background === c ? '✓' : ''}
            </Text>
          ))}
        </View>
      )}
      <Button
        title={closeOnly ? '★ Close friends only (tap to change)' : 'All friends (tap for close friends only)'}
        onPress={() => setCloseOnly((v) => !v)}
        disabled={!!busy}
      />
      <Text style={{ color: 'gray' }}>Disappears after 24 hours.</Text>
      {busy && <Text>{busy}</Text>}
      <Button title="Share" onPress={publish} disabled={!!busy || !canPublish} />
    </ScrollView>
  );
}
