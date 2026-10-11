import { create } from 'zustand';
import { storage } from './lib/storage';
import { hi } from './i18n/hi';

/**
 * Translation layer. Strings are keyed by their English text, so a missing translation falls back to English and
 * adding a language never breaks a screen. `{name}` placeholders are filled from `vars`.
 *
 * `t()` is a plain function (usable in alerts and helpers). The root layout re-renders the app when the language
 * changes, so every screen picks up the new strings.
 */
const dictionaries: Record<string, Record<string, string>> = { hi };

export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'हिन्दी' },
] as const;

const LANG_KEY = 'lang';

export const useLang = create<{ lang: string; setLang: (lang: string) => void }>((set) => ({
  lang: 'en',
  setLang: (lang) => {
    set({ lang });
    storage.set(LANG_KEY, lang).catch(() => undefined);
  },
}));

/** Restores the last language before the first screen renders, so there is no English flash. */
export async function loadSavedLanguage() {
  try {
    const saved = await storage.get(LANG_KEY);
    if (saved) useLang.setState({ lang: saved });
  } catch {
    /* default English */
  }
}

export function translate(lang: string | undefined, text: string, vars?: Record<string, string | number>) {
  let out = (lang && dictionaries[lang]?.[text]) || text;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v));
  return out;
}

export function t(text: string, vars?: Record<string, string | number>) {
  return translate(useLang.getState().lang, text, vars);
}
