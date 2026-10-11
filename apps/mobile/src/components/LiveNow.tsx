import { useEffect } from 'react';
import { t } from '../i18n';
import { FlatList, Pressable, View } from 'react-native';
import { Text } from './themed';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Avatar } from './Avatar';
import { connectSocket } from '../chat/socket';
import { liveApi } from '../lib/live';

/** Friends who are live right now, plus a button to go live yourself. */
export function LiveNow() {
  const router = useRouter();
  const qc = useQueryClient();
  const { data = [] } = useQuery({ queryKey: ['live'], queryFn: liveApi.liveNow });

  useEffect(() => {
    const s = connectSocket();
    const refresh = () => qc.invalidateQueries({ queryKey: ['live'] });
    s.on('live:started', refresh);
    s.on('live:ended', refresh);
    return () => {
      s.off('live:started', refresh);
      s.off('live:ended', refresh);
    };
  }, [qc]);

  return (
    <View style={{ paddingHorizontal: 10, gap: 8 }}>
      <Pressable
        onPress={() => router.push('/live/host')}
        style={{ backgroundColor: '#dc2626', padding: 10, borderRadius: 8, alignItems: 'center' }}
      >
        <Text style={{ color: 'white', fontWeight: '700' }}>{t('● Go live')}</Text>
      </Pressable>
      {data.length > 0 && (
        <FlatList
          horizontal
          data={data}
          keyExtractor={(l) => l.id}
          contentContainerStyle={{ gap: 12 }}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => router.push({ pathname: '/live/[id]', params: { id: item.id } })}
              style={{ alignItems: 'center', width: 76 }}
            >
              <View style={{ borderWidth: 2, borderColor: '#dc2626', borderRadius: 40, padding: 3 }}>
                <Avatar url={item.host.avatarUrl} name={item.host.displayName ?? item.host.username} size={56} />
              </View>
              <Text style={{ color: '#dc2626', fontSize: 10, fontWeight: '700' }}>LIVE · {item.viewerCount}</Text>
              <Text numberOfLines={1} style={{ fontSize: 12 }}>{item.host.displayName ?? item.host.username}</Text>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}
