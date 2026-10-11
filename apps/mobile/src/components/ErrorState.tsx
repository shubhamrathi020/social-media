import { Button, View } from 'react-native';
import { t } from '../i18n';
import { Text } from './themed';
import { useTheme } from '../theme';

/** Shown in place of a list when loading failed (offline, server down...). */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const c = useTheme();
  const offline = error instanceof TypeError; // fetch throws TypeError when the network is unreachable
  return (
    <View style={{ padding: 24, alignItems: 'center', gap: 8 }} accessibilityRole="alert">
      <Text style={{ fontSize: 17, fontWeight: '600' }}>{offline ? t("You're offline") : t('Could not load this')}</Text>
      <Text style={{ color: c.muted, textAlign: 'center' }}>
        {offline ? t('Check your connection and try again.') : error instanceof Error ? error.message : t('Please try again.')}
      </Text>
      <Button title={t('Retry')} onPress={onRetry} />
    </View>
  );
}
