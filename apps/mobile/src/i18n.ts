import { useQuery } from '@tanstack/react-query';
import { settingsApi } from './lib/settings';
import { useAuth } from './state/auth';

/**
 * Minimal translation layer. Strings are keyed by their English text, so untranslated keys fall back to English
 * and adding a language never breaks a screen. The language comes from the server-side setting.
 */
const hi: Record<string, string> = {
  // tabs
  Feed: 'फ़ीड',
  Chats: 'चैट',
  Friends: 'दोस्त',
  Search: 'खोजें',
  Alerts: 'सूचनाएँ',
  Profile: 'प्रोफ़ाइल',
  // sign-in
  'Enter your phone number': 'अपना फ़ोन नंबर डालें',
  'Use international format, e.g. +14155550123': 'अंतरराष्ट्रीय फ़ॉर्मैट में लिखें, जैसे +919876543210',
  'Send code': 'कोड भेजें',
  'Sending…': 'भेजा जा रहा है…',
  'Enter the 6-digit code': '6 अंकों का कोड डालें',
  'Sent to': 'भेजा गया',
  Verify: 'पुष्टि करें',
  'Verifying…': 'पुष्टि हो रही है…',
  // settings
  Settings: 'सेटिंग्स',
  Privacy: 'गोपनीयता',
  Notifications: 'सूचनाएँ',
  Media: 'मीडिया',
  Appearance: 'दिखावट',
  Account: 'खाता',
  'Who can message me': 'मुझे कौन मैसेज कर सकता है',
  'Who can see my last seen': 'मेरा लास्ट सीन कौन देख सकता है',
  'Who can see my stories': 'मेरी स्टोरी कौन देख सकता है',
  'Blocked users': 'ब्लॉक किए गए लोग',
  Messages: 'मैसेज',
  'Friend requests': 'फ़्रेंड रिक्वेस्ट',
  Likes: 'लाइक',
  'Comments and replies': 'कमेंट और जवाब',
  'Live videos': 'लाइव वीडियो',
  'Data saver': 'डेटा सेवर',
  'Autoplay videos': 'वीडियो अपने-आप चलाएँ',
  Theme: 'थीम',
  Language: 'भाषा',
  'Close friends': 'करीबी दोस्त',
  'Logged-in devices': 'लॉग-इन डिवाइस',
  'Download my data': 'मेरा डेटा डाउनलोड करें',
  'Forget my uploaded contacts': 'मेरे अपलोड किए गए कॉन्टैक्ट हटाएँ',
  'Log out': 'लॉग आउट',
  'Delete account': 'खाता हटाएँ',
  Everyone: 'सभी',
  Nobody: 'कोई नहीं',
  System: 'सिस्टम',
  Light: 'लाइट',
  Dark: 'डार्क',
};

const dictionaries: Record<string, Record<string, string>> = { hi };

export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'हिन्दी' },
] as const;

export function translate(lang: string | undefined, text: string) {
  return (lang && dictionaries[lang]?.[text]) || text;
}

/** `t('Settings')` in the current language. Signed-out screens use English until settings are known. */
export function useT() {
  const signedIn = useAuth((s) => s.status === 'signedIn');
  const { data } = useQuery({ queryKey: ['settings'], queryFn: settingsApi.get, enabled: signedIn, staleTime: 60_000 });
  return (text: string) => translate(data?.language, text);
}
