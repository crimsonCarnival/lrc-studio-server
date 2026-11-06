import { describe, it, expect } from 'vitest';
import { resolveEmailTheme, deriveEmailTheme } from './email-themes.js';
import { EMAIL_PALETTES } from './email-palettes.js';

const HEX6 = /^#[0-9a-f]{6}$/;

describe('resolveEmailTheme', () => {
  it('keeps the hand-tuned dark and light themes', () => {
    expect(resolveEmailTheme('light').bg).toBe('#faf4ed');
    expect(resolveEmailTheme('dark').bg).toBe('#09090b');
  });

  it('derives a palette theme instead of falling back to dark', () => {
    expect(resolveEmailTheme('nord-light').bg).not.toBe(resolveEmailTheme('dark').bg);
    expect(resolveEmailTheme('dracula').primary).toMatch(HEX6);
  });

  it('falls back to dark for unknown ids and missing values', () => {
    expect(resolveEmailTheme('nope')).toBe(resolveEmailTheme('dark'));
    expect(resolveEmailTheme(null)).toBe(resolveEmailTheme('dark'));
  });

  it('uses a valid custom theme', () => {
    const custom = JSON.stringify({ bg: '#ffffff', main: '#112233', sub: '#888888', text: '#000000', error: '#cc0000' });
    expect(resolveEmailTheme('custom', custom).primary).toBe('#112233');
  });

  it('rejects a custom theme that is not strict hex (it ends up in inline CSS)', () => {
    const evil = JSON.stringify({ bg: '#fff;}</style><script>', main: '#112233', sub: '#888888', text: '#000000', error: '#cc0000' });
    expect(resolveEmailTheme('custom', evil)).toBe(resolveEmailTheme('dark'));
    expect(resolveEmailTheme('custom', '{not json')).toBe(resolveEmailTheme('dark'));
    expect(resolveEmailTheme('custom', null)).toBe(resolveEmailTheme('dark'));
  });
});

describe('deriveEmailTheme', () => {
  it('emits 6-digit hex for every solid colour of every palette (buildStyles appends alpha suffixes)', () => {
    for (const [bg, main, sub, text, error] of Object.values(EMAIL_PALETTES)) {
      const th = deriveEmailTheme({ bg, main, sub, text, error });
      for (const k of ['bg', 'surface', 'surfaceAlt', 'text', 'textMuted', 'textSubtle', 'primary', 'primaryDark', 'primaryContrast', 'border', 'danger', 'info', 'warning'] as const) {
        expect(th[k]).toMatch(HEX6);
      }
    }
  });
});
