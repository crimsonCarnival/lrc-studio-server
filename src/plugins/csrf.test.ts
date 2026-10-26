import { describe, it, expect } from 'vitest';
import { isCrossSiteWrite } from './csrf.js';

const ALLOWED = new Set(['https://www.lrcstudio.app']);
const check = (method: string, headers: { origin?: string; 'sec-fetch-site'?: string }) =>
  isCrossSiteWrite(method, headers, ALLOWED);

describe('isCrossSiteWrite', () => {
  it('never blocks safe methods', () => {
    expect(check('GET', { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' })).toBe(false);
  });

  it('blocks a cross-site write by Sec-Fetch-Site', () => {
    expect(check('POST', { 'sec-fetch-site': 'cross-site' })).toBe(true);
  });

  it('lets same-site subdomains through without listing them', () => {
    expect(check('POST', { 'sec-fetch-site': 'same-site', origin: 'https://admin.lrcstudio.app' })).toBe(false);
    expect(check('DELETE', { 'sec-fetch-site': 'same-origin' })).toBe(false);
  });

  it('falls back to the Origin allowlist without Sec-Fetch-Site', () => {
    expect(check('POST', { origin: 'https://www.lrcstudio.app' })).toBe(false);
    expect(check('POST', { origin: 'https://evil.example' })).toBe(true);
    expect(check('POST', { origin: 'null' })).toBe(true);
  });

  it('lets non-browser callers (no Origin, no Sec-Fetch-Site) through', () => {
    expect(check('POST', {})).toBe(false);
  });
});
