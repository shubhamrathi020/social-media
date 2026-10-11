import { ActivityIndicator, View } from 'react-native';
import { Image } from 'expo-image';
import { useQuery } from '@tanstack/react-query';
import { Text } from './themed';
import { decryptAttachment } from '../chat/e2e';
import { ChatMessage } from '../chat/types';

/** Downloads the encrypted blob, decrypts it on the phone and shows it. */
export function EncryptedImage({ message }: { message: ChatMessage }) {
  const { data, isLoading } = useQuery({
    queryKey: ['decrypted-attachment', message.id],
    queryFn: () => decryptAttachment(message),
    staleTime: Infinity,
    gcTime: 10 * 60_000,
  });
  const box = { width: 200, height: 150, borderRadius: 8, marginBottom: 4 };
  if (isLoading) {
    return (
      <View style={[box, { alignItems: 'center', justifyContent: 'center', backgroundColor: '#0002' }]}>
        <ActivityIndicator />
      </View>
    );
  }
  if (!data) return <Text style={{ fontStyle: 'italic' }}>🔒 Photo could not be decrypted</Text>;
  return <Image source={{ uri: data }} style={box} contentFit="cover" accessibilityLabel="Encrypted photo" />;
}
