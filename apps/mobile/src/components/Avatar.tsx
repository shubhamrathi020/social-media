import { View } from 'react-native';
import { Image } from 'expo-image';
import { Text } from './themed';

export function Avatar({ url, name, size = 40 }: { url?: string | null; name?: string | null; size?: number }) {
  const base = { width: size, height: size, borderRadius: size / 2 };
  if (url) {
    return (
      <Image
        source={{ uri: url }}
        style={[base, { backgroundColor: '#ddd' }]}
        cachePolicy="memory-disk"
        accessibilityLabel={name ? `${name}'s photo` : 'Profile photo'}
      />
    );
  }
  return (
    <View
      style={[base, { backgroundColor: '#c9d3e6', alignItems: 'center', justifyContent: 'center' }]}
      accessibilityLabel={name ? `${name}'s photo` : 'Profile photo'}
    >
      {/* Fixed dark text: the circle is light in both themes. */}
      <Text style={{ fontWeight: '700', fontSize: size / 2.2, color: '#1f2937' }}>{(name ?? '?').slice(0, 1).toUpperCase()}</Text>
    </View>
  );
}
