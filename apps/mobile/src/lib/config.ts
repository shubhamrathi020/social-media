import Constants from 'expo-constants';

// On a physical phone, localhost is the phone itself. Derive the dev machine's LAN IP from Expo.
const host = Constants.expoConfig?.hostUri?.split(':')[0] ?? 'localhost';

export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? `http://${host}:3000/v1`;
export const SOCKET_URL = process.env.EXPO_PUBLIC_SOCKET_URL ?? `http://${host}:3000`;
