import { describe, it, expect } from 'vitest';
import { buildAppOriginAllowlist, resolveAllowedAppOrigin, toOrigin } from './allowed-origins.js';

const env = {
  APP_URLS: ['http://localhost:5173', 'https://www.lrcstudio.app/'],
  CORS_ORIGIN: 'http://localhost:5173, "https://m.lrcstudio.app", https://admin.lrcstudio.app/',
};

describe('app origin allowlist', () => {
  it('covers every APP_URL and every CORS_ORIGIN entry, not just the first', () => {
    const set = buildAppOriginAllowlist(env);
    for (const o of ['https://www.lrcstudio.app', 'https://m.lrcstudio.app', 'https://admin.lrcstudio.app', 'http://localhost:5173']) {
      expect(set.has(o)).toBe(true);
    }
  });

  it('survives malformed entries instead of throwing', () => {
    expect(() => buildAppOriginAllowlist({ APP_URLS: ['not a url', ''], CORS_ORIGIN: 'www.lrcstudio.app' })).not.toThrow();
  });

  it('resolves only exact allowlisted origins (never reflects)', () => {
    expect(resolveAllowedAppOrigin('https://m.lrcstudio.app/some/path?x=1', env)).toBe('https://m.lrcstudio.app');
    expect(resolveAllowedAppOrigin('https://evil.lrcstudio.app', env)).toBeUndefined();
    expect(resolveAllowedAppOrigin('https://www.lrcstudio.app.evil.com', env)).toBeUndefined();
    expect(resolveAllowedAppOrigin('http://www.lrcstudio.app', env)).toBeUndefined();
    expect(resolveAllowedAppOrigin('javascript:alert(1)', env)).toBeUndefined();
    expect(resolveAllowedAppOrigin(undefined, env)).toBeUndefined();
  });

  it('toOrigin rejects non-http schemes', () => {
    expect(toOrigin('ftp://x.com')).toBeNull();
  });
});
