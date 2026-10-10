import { useState } from 'react';
import { Alert, Button, ScrollView, View } from 'react-native';
import { Image } from 'expo-image';
import { Text, TextInput } from '../../src/components/themed';
import { Stack, useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { MAX_POST_SLIDES } from '@social/shared';
import { PickedFile, pickMany, uploadMedia } from '../../src/lib/media';
import { Audience, postsApi } from '../../src/lib/posts';

const AUDIENCES: { value: Audience; label: string }[] = [
  { value: 'friends', label: 'Friends' },
  { value: 'close_friends', label: '★ Close friends' },
  { value: 'public', label: 'Public' },
];

export default function NewPost() {
  const router = useRouter();
  const qc = useQueryClient();
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [caption, setCaption] = useState('');
  const [audience, setAudience] = useState<Audience>('friends');
  const [progress, setProgress] = useState<string | null>(null);

  async function choose() {
    try {
      const picked = await pickMany(MAX_POST_SLIDES - files.length);
      setFiles((cur) => [...cur, ...picked].slice(0, MAX_POST_SLIDES));
    } catch (e) {
      Alert.alert('Cannot open library', e instanceof Error ? e.message : '');
    }
  }

  async function publish() {
    try {
      const mediaIds: string[] = [];
      for (let i = 0; i < files.length; i++) {
        setProgress(`Uploading ${i + 1} of ${files.length}…`);
        const m = await uploadMedia(files[i], 'post', (p) =>
          setProgress(`Uploading ${i + 1} of ${files.length}… ${Math.round(p * 100)}%`),
        );
        mediaIds.push(m.id);
      }
      setProgress('Publishing…');
      await postsApi.create({ caption: caption.trim() || undefined, audience, mediaIds });
      await qc.invalidateQueries({ queryKey: ['feed'] });
      router.back();
    } catch (e) {
      Alert.alert('Could not publish', e instanceof Error ? e.message : '');
    } finally {
      setProgress(null);
    }
  }

  const busy = progress !== null;
  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Stack.Screen options={{ headerShown: true, title: 'New post' }} />
      <Text style={{ fontWeight: '600' }}>
        Slides ({files.length}/{MAX_POST_SLIDES})
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {files.map((f, i) => (
          <View key={f.uri} style={{ alignItems: 'center' }}>
            <Image source={{ uri: f.uri }} style={{ width: 90, height: 90, borderRadius: 8, backgroundColor: '#ddd' }} />
            <Text style={{ fontSize: 11 }}>{f.kind === 'video' ? '🎬 video' : `#${i + 1}`}</Text>
            <Button title="Remove" onPress={() => setFiles((cur) => cur.filter((x) => x !== f))} disabled={busy} />
          </View>
        ))}
      </View>
      <Button title="Add photos / videos" onPress={choose} disabled={busy || files.length >= MAX_POST_SLIDES} />

      <TextInput
        value={caption}
        onChangeText={setCaption}
        placeholder="Write a caption…"
        multiline
        maxLength={2200}
        style={{ borderWidth: 1, borderRadius: 8, padding: 12, minHeight: 80 }}
      />
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {AUDIENCES.map((a) => (
          <Button
            key={a.value}
            title={`${audience === a.value ? '● ' : '○ '}${a.label}`}
            onPress={() => setAudience(a.value)}
            disabled={busy}
          />
        ))}
      </View>
      {progress && <Text>{progress}</Text>}
      <Button title="Publish" onPress={publish} disabled={busy || files.length === 0} />
    </ScrollView>
  );
}
