import { useEffect } from 'react';
import { Appearance } from 'react-native';
import { Tabs } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useChatEvents } from '../../src/chat/use-chat-events';
import { usePush } from '../../src/lib/push';
import { notificationsApi, settingsApi } from '../../src/lib/settings';

export default function TabsLayout() {
  useChatEvents();
  usePush();

  const unread = useQuery({
    queryKey: ['unread'],
    queryFn: notificationsApi.unread,
    refetchInterval: 60_000,
  });

  // Apply the saved theme preference once settings are known.
  const settings = useQuery({ queryKey: ['settings'], queryFn: settingsApi.get });
  useEffect(() => {
    const t = settings.data?.theme;
    if (t) Appearance.setColorScheme(t === 'system' ? null : t);
  }, [settings.data?.theme]);

  const badge = unread.data?.unread ? Math.min(unread.data.unread, 99) : undefined;

  return (
    <Tabs>
      <Tabs.Screen name="feed" options={{ title: 'Feed' }} />
      <Tabs.Screen name="chats" options={{ title: 'Chats' }} />
      <Tabs.Screen name="friends" options={{ title: 'Friends' }} />
      <Tabs.Screen name="search" options={{ title: 'Search' }} />
      <Tabs.Screen name="alerts" options={{ title: 'Alerts', tabBarBadge: badge }} />
      <Tabs.Screen name="index" options={{ title: 'Profile' }} />
    </Tabs>
  );
}
