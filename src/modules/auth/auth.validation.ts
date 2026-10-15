// server/src/modules/auth/auth.validation.ts

// The top level of the web client is shared: `/:accountName/projects/...` and
// `/:accountName/lists/...` sit beside the app's own routes, so an account name
// must never equal a first path segment the client or API serves.
export const RESERVED_USERNAMES = new Set([
  'admin', 'api', 'assets', 'auth', 'change-password', 'explore', 'feed', 'guide',
  'home', 'leaderboard', 'library', 'lists', 'login', 'notifications', 'og',
  'profile', 'project', 'projects', 'register', 'reset-password', 'search',
  'settings', 'share', 'static', 'u', 'uploads', 'verify-email',
]);

// Allows lowercase letters, digits, _ - . :  (3–30 chars)
const ACCOUNT_NAME_REGEX = /^[a-z0-9_.:-]{3,30}$/;

export function isValidAccountName(name: string): boolean {
  return ACCOUNT_NAME_REGEX.test(name);
}

export function isReservedAccountName(name: string): boolean {
  return RESERVED_USERNAMES.has(name.toLowerCase());
}
