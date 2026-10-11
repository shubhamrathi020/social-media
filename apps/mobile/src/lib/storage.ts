import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/**
 * Small key-value store for tokens and sync cursors. Phones use the OS keychain/keystore (expo-secure-store);
 * the web build (used for local testing) falls back to localStorage, which is not secret storage.
 */
const web = Platform.OS === 'web';

export const storage = {
  get: async (key: string): Promise<string | null> => (web ? globalThis.localStorage?.getItem(key) ?? null : SecureStore.getItemAsync(key)),
  set: async (key: string, value: string): Promise<void> => {
    if (web) globalThis.localStorage?.setItem(key, value);
    else await SecureStore.setItemAsync(key, value);
  },
  remove: async (key: string): Promise<void> => {
    if (web) globalThis.localStorage?.removeItem(key);
    else await SecureStore.deleteItemAsync(key);
  },
};
