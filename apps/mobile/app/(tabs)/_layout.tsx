import { useEffect } from 'react';
import { Appearance } from 'react-native';
import { Tabs } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
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
    if (theme) Appearance.setColorScheme?.(theme === 'system' ? null : theme);
  }, [settings.data?.theme]);

  const badge = unread.data?.unread ? Math.min(unread.data.unread, 99) : undefined;

  return (
    <Tabs>
      <Tabs.Screen name="index" options={{ title: t('Feed'), tabBarIcon: icon('home') }} />
      <Tabs.Screen name="chats" options={{ title: t('Chats'), tabBarIcon: icon('chatbubbles') }} />
      <Tabs.Screen name="friends" options={{ title: t('Friends'), tabBarIcon: icon('people') }} />
      <Tabs.Screen name="search" options={{ title: t('Search'), tabBarIcon: icon('search') }} />
      <Tabs.Screen name="alerts" options={{ title: t('Alerts'), tabBarBadge: badge, tabBarIcon: icon('notifications') }} />
      <Tabs.Screen name="profile" options={{ title: t('Profile'), tabBarIcon: icon('person-circle') }} />
    </Tabs>
  );
}

type IconName = 'home' | 'chatbubbles' | 'people' | 'search' | 'notifications' | 'person-circle';

/** Filled icon when the tab is active, outline otherwise. */
const icon =
  (name: IconName) =>
  ({ color, size, focused }: { color: string; size: number; focused: boolean }) => (
    <Ionicons name={focused ? name : (`${name}-outline` as const)} size={size} color={color} />
  );
