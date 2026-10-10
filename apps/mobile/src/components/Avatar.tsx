import { Image, Text, View } from 'react-native';

export function Avatar({ url, name, size = 40 }: { url?: string | null; name?: string | null; size?: number }) {
  const base = { width: size, height: size, borderRadius: size / 2 };
  if (url) return <Image source={{ uri: url }} style={[base, { backgroundColor: '#ddd' }]} />;
  return (
    <View style={[base, { backgroundColor: '#c9d3e6', alignItems: 'center', justifyContent: 'center' }]}>
      <Text style={{ fontWeight: '700', fontSize: size / 2.2 }}>{(name ?? '?').slice(0, 1).toUpperCase()}</Text>
    </View>
  );
}
