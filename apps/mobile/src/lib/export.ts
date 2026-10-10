import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { api } from './api';

/** Downloads everything the server holds about you and opens the share sheet to save or send the file. */
export async function exportMyData() {
  const data = await api<unknown>('/users/me/export');
  const file = `${FileSystem.cacheDirectory}my-data-${new Date().toISOString().slice(0, 10)}.json`;
  await FileSystem.writeAsStringAsync(file, JSON.stringify(data, null, 2));
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(file, { mimeType: 'application/json', dialogTitle: 'Save your data' });
  } else {
    throw new Error(`Sharing is not available on this device. The file is at ${file}`);
  }
}
