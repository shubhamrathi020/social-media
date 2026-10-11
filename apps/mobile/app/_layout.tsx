import { useEffect, useState } from 'react';
import { t } from '../src/i18n';
import { ActivityIndicator, Button, View, useColorScheme } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Text } from '../src/components/themed';
import { useAuth } from '../src/state/auth';
import { loadSavedLanguage, useLang } from '../src/i18n';

function AuthGate() {
  const status = useAuth((s) => s.status);
  const bootstrap = useAuth((s) => s.bootstrap);
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    // The saved language is restored first so the first screen is already in the right language.
    loadSavedLanguage().finally(() => bootstrap());
  }, [bootstrap]);

  useEffect(() => {
    if (status === 'loading') return;
    const inAuth = segments[0] === '(auth)';
    if (status === 'signedOut' && !inAuth) router.replace('/(auth)/phone');
    if (status === 'signedIn' && inAuth) router.replace('/');
  }, [status, segments, router]);

  if (status === 'loading') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator />
      </View>
    );
  }
  return <Stack screenOptions={{ headerShown: false }} />;
}

export default function RootLayout() {
  const [client] = useState(() => new QueryClient());
  const lang = useLang((s) => s.lang);
  return (
    <QueryClientProvider client={client}>
      <NavigationTheme key={lang}>
        <AuthGate />
      </NavigationTheme>
    </QueryClientProvider>
  );
}

/** Screen, header and tab bar colours follow light/dark mode. */
function NavigationTheme({ children }: { children: React.ReactNode }) {
  const scheme = useColorScheme();
  return <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>{children}</ThemeProvider>;
}

/**
 * Shown by expo-router instead of a white screen when a screen throws while rendering.
 * The user can retry; the error text helps when someone sends a screenshot.
 */
export function ErrorBoundary({ error, retry }: { error: Error; retry: () => Promise<void> }) {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: '700' }}>{t('Something went wrong')}</Text>
      <Text style={{ textAlign: 'center', opacity: 0.7 }}>{error.message}</Text>
      <Button title={t('Try again')} onPress={retry} />
    </View>
  );
}
