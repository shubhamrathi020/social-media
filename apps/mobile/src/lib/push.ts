import { useEffect } from 'react';
import { Platform } from 'react-native';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { notificationsApi } from './settings';

// Show alerts while the app is in the foreground too.
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowAlert: true, shouldPlaySound: false, shouldSetBadge: false }),
});

/** Asks for permission and registers this device's Expo push token. Fails quietly (simulators, no projectId). */
export async function registerForPush(): Promise<void> {
  try {
    if (!Device.isDevice) return;
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'default',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }
    const existing = await Notifications.getPermissionsAsync();
    let status = existing.status;
    if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
    if (status !== 'granted') return;

    const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
    const token = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    await notificationsApi.registerPushToken(token.data);
  } catch {
    // Push is an enhancement; the app works without it.
  }
}

type Data = { type?: string; entityType?: string; entityId?: string; conversationId?: string };

/** Registers for push once signed in and routes notification taps to the right screen. */
export function usePush() {
  const router = useRouter();

  useEffect(() => {
    void registerForPush();

    const open = (d: Data) => {
      if (d.type === 'message' && d.conversationId) {
        router.push({ pathname: '/chat/[id]', params: { id: d.conversationId } });
      } else if (d.entityType === 'post' && d.entityId) {
        router.push({ pathname: '/post/[id]', params: { id: d.entityId } });
      } else if (d.entityType === 'live' && d.entityId) {
        router.push({ pathname: '/live/[id]', params: { id: d.entityId } });
      } else if (d.type === 'friend_request' || d.type === 'friend_accepted') {
        router.push('/friends');
      }
    };

    const sub = Notifications.addNotificationResponseReceivedListener((resp) =>
      open(resp.notification.request.content.data as Data),
    );
    return () => sub.remove();
  }, [router]);
}
