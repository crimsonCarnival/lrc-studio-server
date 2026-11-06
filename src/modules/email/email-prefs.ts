import Settings from '../settings/settings.model.js';
import type { EmailPrefs } from './email.service.js';

type InterfaceLean = { interface?: { defaultLanguage?: string; theme?: string; customTheme?: string } } | null;

/** Language and theme a user chose in Settings, shaped for the email senders. Empty prefs when unset. */
export async function loadEmailPrefs(userId: unknown): Promise<EmailPrefs> {
  if (!userId) return {};
  const s = (await Settings.findOne({ userId }).select('interface').lean()) as InterfaceLean;
  return { lang: s?.interface?.defaultLanguage, theme: s?.interface?.theme, customTheme: s?.interface?.customTheme };
}
