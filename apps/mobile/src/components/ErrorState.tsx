import { Button, View } from 'react-native';
import { Text } from './themed';
import { useTheme } from '../theme';

/** Shown in place of a list when loading failed (offline, server down...). */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const c = useTheme();
  const offline = error instanceof TypeError; // fetch throws TypeError when the network is unreachable
  return (
    <View style={{ padding: 24, alignItems: 'center', gap: 8 }} accessibilityRole="alert">
      <Text style={{ fontSize: 17, fontWeight: '600' }}>{offline ? "You're offline" : 'Could not load this'}</Text>
      <Text style={{ color: c.muted, textAlign: 'center' }}>
        {offline ? 'Check your connection and try again.' : error instanceof Error ? error.message : 'Please try again.'}
      </Text>
      <Button title="Retry" onPress={onRetry} />
    </View>
  );
}
