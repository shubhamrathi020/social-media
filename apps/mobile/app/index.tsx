import { ActivityIndicator, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { MAX_POST_SLIDES } from '@social/shared';
import { API_URL } from '../src/lib/config';

type Health = { status: string; postgres: string; redis: string };

export default function Home() {
  const { data, error, isLoading } = useQuery<Health>({
    queryKey: ['health'],
    queryFn: async () => {
      const res = await fetch(`${API_URL}/health`);
      if (!res.ok) throw new Error(`API ${res.status}`);
      return res.json();
    },
  });

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 }}>
      <Text style={{ fontSize: 24, fontWeight: '600' }}>Social</Text>
      <Text>Max slides per post: {MAX_POST_SLIDES}</Text>
      {isLoading && <ActivityIndicator />}
      {error && <Text>API unreachable: {String(error.message)}</Text>}
      {data && <Text>API: {data.status} · pg {data.postgres} · redis {data.redis}</Text>}
    </View>
  );
}
