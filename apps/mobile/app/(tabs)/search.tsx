import { useEffect, useState } from 'react';
import { Alert, Button, FlatList, Text, TextInput, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Relationship, SearchResult, friendsApi, nameOf } from '../../src/lib/friends';

function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const LABEL: Record<Relationship, string> = {
  self: '',
  none: 'Add friend',
  friends: 'Friends',
  request_sent: 'Requested',
  request_received: 'Respond in Friends tab',
  blocked: 'Blocked',
  blocked_by: '',
};

export default function SearchScreen() {
  const [q, setQ] = useState('');
  const debounced = useDebounced(q.trim());
  const qc = useQueryClient();

  const results = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => friendsApi.search(debounced),
    enabled: debounced.length >= 2,
  });

  const add = useMutation({
    mutationFn: (id: string) => friendsApi.sendRequest(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['search'] }),
    onError: (e) => Alert.alert('Error', e instanceof Error ? e.message : 'Something went wrong'),
  });

  return (
    <View style={{ flex: 1, padding: 12, gap: 8 }}>
      <TextInput
        value={q}
        onChangeText={setQ}
        placeholder="Search by username or name"
        autoCapitalize="none"
        style={{ borderWidth: 1, borderRadius: 8, padding: 12 }}
      />
      <FlatList<SearchResult>
        data={results.data ?? []}
        keyExtractor={(u) => u.id}
        ListEmptyComponent={
          debounced.length >= 2 && !results.isFetching ? <Text style={{ padding: 12 }}>No results</Text> : null
        }
        renderItem={({ item }) => (
          <View style={{ paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontWeight: '600' }}>{nameOf(item)}</Text>
              {!!item.username && <Text style={{ color: 'gray' }}>@{item.username}</Text>}
            </View>
            {item.relationship === 'none' ? (
              <Button title="Add friend" onPress={() => add.mutate(item.id)} />
            ) : (
              <Text style={{ color: 'gray' }}>{LABEL[item.relationship]}</Text>
            )}
          </View>
        )}
      />
    </View>
  );
}
