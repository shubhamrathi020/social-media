import { useColorScheme } from 'react-native';

export interface Palette {
  background: string;
  card: string;
  text: string;
  muted: string;
  border: string;
  primary: string;
  onPrimary: string;
  danger: string;
  success: string;
  /** Subtle fill for section headers, inputs and the other person's chat bubbles. */
  subtle: string;
  /** Background of unread rows. */
  highlight: string;
}

export const light: Palette = {
  background: '#ffffff',
  card: '#ffffff',
  text: '#111827',
  muted: '#6b7280',
  border: '#e5e7eb',
  primary: '#2563eb',
  onPrimary: '#ffffff',
  danger: '#dc2626',
  success: '#16a34a',
  subtle: '#f3f4f6',
  highlight: '#eff6ff',
};

export const dark: Palette = {
  background: '#0b0d12',
  card: '#151922',
  text: '#e5e7eb',
  muted: '#9ca3af',
  border: '#262b36',
  primary: '#60a5fa',
  onPrimary: '#0b0d12',
  danger: '#f87171',
  success: '#4ade80',
  subtle: '#1c212b',
  highlight: '#172036',
};

/** Colours for the current light/dark appearance (the Settings theme choice feeds Appearance). */
export function useTheme(): Palette {
  return useColorScheme() === 'dark' ? dark : light;
}
