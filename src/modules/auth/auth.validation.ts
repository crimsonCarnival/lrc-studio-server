// server/src/modules/auth/auth.validation.ts

export const RESERVED_USERNAMES = new Set([
  'home', 'library', 'admin', 'settings', 'feed', 'search',
  'project', 'uploads', 'verify-email', 'auth', 'share', 'lists',
  'api', 'static', 'assets',
]);

// Allows lowercase letters, digits, _ - . :  (3–30 chars)
const ACCOUNT_NAME_REGEX = /^[a-z0-9_.:-]{3,30}$/;

export function isValidAccountName(name: string): boolean {
  return ACCOUNT_NAME_REGEX.test(name);
}

export function isReservedAccountName(name: string): boolean {
  return RESERVED_USERNAMES.has(name.toLowerCase());
}
