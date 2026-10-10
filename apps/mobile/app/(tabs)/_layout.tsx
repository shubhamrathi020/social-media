import { Tabs } from 'expo-router';
import { useChatEvents } from '../../src/chat/use-chat-events';

export default function TabsLayout() {
  useChatEvents();
  return (
    <Tabs>
      <Tabs.Screen name="feed" options={{ title: 'Feed' }} />
      <Tabs.Screen name="chats" options={{ title: 'Chats' }} />
      <Tabs.Screen name="friends" options={{ title: 'Friends' }} />
      <Tabs.Screen name="search" options={{ title: 'Search' }} />
      <Tabs.Screen name="index" options={{ title: 'Profile' }} />
    </Tabs>
  );
}
