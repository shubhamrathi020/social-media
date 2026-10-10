import { useEffect } from 'react';
import { Appearance } from 'react-native';
import { Tabs } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useChatEvents } from '../../src/chat/use-chat-events';
import { usePush } from '../../src/lib/push';
import { notificationsApi, settingsApi } from '../../src/lib/settings';
import { useT } from '../../src/i18n';

export default function TabsLayout() {
  useChatEvents();
  usePush();
  const t = useT();

  const unread = useQuery({
    queryKey: ['unread'],
    queryFn: notificationsApi.unread,
    refetchInterval: 60_000,
  });

  // Apply the saved theme preference once settings are known.
  const settings = useQuery({ queryKey: ['settings'], queryFn: settingsApi.get });
  useEffect(() => {
    const theme = settings.data?.theme;
    if (theme) Appearance.setColorScheme(theme === 'system' ? null : theme);
  }, [settings.data?.theme]);

  const badge = unread.data?.unread ? Math.min(unread.data.unread, 99) : undefined;

  return (
    <Tabs>
      <Tabs.Screen name="feed" options={{ title: t('Feed') }} />
      <Tabs.Screen name="chats" options={{ title: t('Chats') }} />
      <Tabs.Screen name="friends" options={{ title: t('Friends') }} />
      <Tabs.Screen name="search" options={{ title: t('Search') }} />
      <Tabs.Screen name="alerts" options={{ title: t('Alerts'), tabBarBadge: badge }} />
      <Tabs.Screen name="index" options={{ title: t('Profile') }} />
    </Tabs>
  );
}
