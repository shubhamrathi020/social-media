import { Pressable, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Avatar } from './Avatar';
import { Text } from './themed';
import { friendsApi, nameOf } from '../lib/friends';
import { useTheme } from '../theme';

/** Checkbox list of friends, minus `exclude` (e.g. people already in the group). */
export function FriendPicker({
  selected,
  onChange,
  exclude = [],
}: {
  selected: string[];
  onChange: (ids: string[]) => void;
  exclude?: string[];
}) {
  const c = useTheme();
  const { data = [], isLoading } = useQuery({ queryKey: ['friends'], queryFn: friendsApi.friends });
  const options = data.filter((f) => !exclude.includes(f.id));

  if (isLoading) return <Text style={{ color: c.muted, padding: 12 }}>Loading friends…</Text>;
  if (options.length === 0) return <Text style={{ color: c.muted, padding: 12 }}>No friends to add.</Text>;

  return (
    <View>
      {options.map((f) => {
        const on = selected.includes(f.id);
        return (
          <Pressable
            key={f.id}
            onPress={() => onChange(on ? selected.filter((x) => x !== f.id) : [...selected, f.id])}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: on }}
            accessibilityLabel={nameOf(f)}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, paddingHorizontal: 12 }}
          >
            <Avatar url={f.avatarUrl} name={nameOf(f)} size={36} />
            <Text style={{ flex: 1, fontSize: 16 }}>{nameOf(f)}</Text>
            <Text style={{ fontSize: 20, color: on ? c.primary : c.muted }}>{on ? '☑' : '☐'}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
