import { describe, it, expect } from 'vitest';
import { isReservedAccountName } from './auth.validation.js';

describe('reserved names', () => {
  it('covers every top-level client route segment', () => {
    for (const n of [
      'admin', 'auth', 'explore', 'feed', 'guide', 'home', 'leaderboard', 'library', 'login',
      'notifications', 'profile', 'project', 'projects', 'register', 'reset-password',
      'change-password', 'search', 'settings', 'share', 'u', 'uploads', 'verify-email', 'og', 'api',
    ]) {
      expect(isReservedAccountName(n), n).toBe(true);
    }
    expect(isReservedAccountName('Explore')).toBe(true);
    expect(isReservedAccountName('32blunts')).toBe(false);
  });
});
