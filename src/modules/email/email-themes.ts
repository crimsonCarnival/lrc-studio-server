import { EMAIL_PALETTES } from './email-palettes.js';

export interface EmailTheme {
  bg: string;           // outer page background
  surface: string;      // card background
  surfaceAlt: string;   // header background
  text: string;         // body text
  textMuted: string;    // secondary text
  textSubtle: string;   // footer / fine print
  primary: string;      // accent / CTA button
  primaryDark: string;  // button hover / gradient end
  primaryContrast: string; // text on primary button
  border: string;       // dividers
  danger: string;       // ban/warning text
  dangerBg: string;     // ban/warning block bg
  info: string;         // info box text
  infoBg: string;       // info box bg
  infoBorder: string;   // info box border
  warning: string;      // security notice text
  warningBg: string;    // security notice bg
  warningBorder: string;
}

const THEMES: Record<string, EmailTheme> = {
  dark: {
    bg:              '#09090b',
    surface:         '#18181b',
    surfaceAlt:      '#27272a',
    text:            '#f4f4f5',
    textMuted:       '#a1a1a6',
    textSubtle:      '#71717a',
    primary:         '#c4a7e7',
    primaryDark:     '#9f7cc7',
    primaryContrast: '#09090b',
    border:          '#3f3f46',
    danger:          '#f87171',
    dangerBg:        'rgba(239,68,68,0.06)',
    info:            '#c4a7e7',
    infoBg:          'rgba(196,167,231,0.06)',
    infoBorder:      'rgba(196,167,231,0.25)',
    warning:         '#fbbf24',
    warningBg:       'rgba(245,158,11,0.06)',
    warningBorder:   'rgba(245,158,11,0.25)',
  },
  light: {
    bg:              '#faf4ed',
    surface:         '#fffaf3',
    surfaceAlt:      '#f2e9e1',
    text:            '#575279',
    textMuted:       '#6f6a86',
    textSubtle:      '#9893a5',
    primary:         '#b4637a',
    primaryDark:     '#9b4d65',
    primaryContrast: '#fffaf3',
    border:          '#dfdad9',
    danger:          '#b4637a',
    dangerBg:        'rgba(180,99,122,0.06)',
    info:            '#286983',
    infoBg:          'rgba(40,105,131,0.06)',
    infoBorder:      'rgba(40,105,131,0.25)',
    warning:         '#d87c3a',
    warningBg:       'rgba(216,124,58,0.06)',
    warningBorder:   'rgba(216,124,58,0.25)',
  },
};

// 'system' cannot be resolved server-side — fall back to dark
export function getEmailTheme(theme?: string | null): EmailTheme {
  return THEMES[theme ?? 'dark'] ?? THEMES.dark;
}

// ---- palette-derived themes ----
// Mirrors the client's themeTokens() in spirit (not pixel for pixel): five colours in, a readable email theme out.

type Palette = { bg: string; main: string; sub: string; text: string; error: string };

const HEX = /^#[0-9a-f]{6}$/i;

const parse = (hex: string): [number, number, number] => {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const toHex = (rgb: number[]): string =>
  `#${rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
const mix = (a: string, b: string, amount: number): string => {
  const [x, y] = [parse(a), parse(b)];
  return toHex(x.map((v, i) => v + (y[i] - v) * amount));
};
const rgba = (hex: string, alpha: number): string => `rgba(${parse(hex).join(',')},${alpha})`;
const luminance = (hex: string): number => {
  const [r, g, b] = parse(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
// Push fg toward white/black until it reaches `min` contrast on bg. Also normalizes to a 6-digit hex, which
// buildStyles needs for its `${primary}1a` alpha suffixes.
const ensureContrast = (fg: string, bg: string, min: number): string => {
  const start = toHex(parse(fg));
  if (contrast(start, bg) >= min) return start;
  const target = luminance(bg) > 0.179 ? '#000000' : '#ffffff';
  for (let step = 1; step <= 20; step++) {
    const next = mix(start, target, step / 20);
    if (contrast(next, bg) >= min) return next;
  }
  return target;
};

export function deriveEmailTheme(p: Palette): EmailTheme {
  const bg = toHex(parse(p.bg));
  const light = luminance(bg) > 0.179;
  const text = ensureContrast(p.text, bg, 4.5);
  const primary = ensureContrast(p.main, bg, 3);
  const danger = ensureContrast(p.error, bg, 3);
  const warning = ensureContrast(light ? '#d97706' : '#fbbf24', bg, 3);
  return {
    bg: light ? bg : mix(bg, '#000000', 0.2),
    surface: light ? mix(bg, '#ffffff', 0.55) : bg,
    surfaceAlt: light ? mix(bg, text, 0.07) : mix(bg, text, 0.12),
    text,
    textMuted: ensureContrast(mix(p.sub, text, 0.25), bg, 4.5),
    textSubtle: ensureContrast(p.sub, bg, 3),
    primary,
    primaryDark: mix(primary, bg, 0.2),
    primaryContrast: contrast('#000000', primary) >= contrast('#ffffff', primary) ? '#000000' : '#ffffff',
    border: light ? mix(bg, text, 0.15) : mix(bg, text, 0.18),
    danger,
    dangerBg: rgba(danger, 0.06),
    info: primary,
    infoBg: rgba(primary, 0.06),
    infoBorder: rgba(primary, 0.25),
    warning,
    warningBg: rgba(warning, 0.06),
    warningBorder: rgba(warning, 0.25),
  };
}

/** Parse the stored `interface.customTheme` JSON. Colours land in inline CSS, so only strict 6-digit hex passes. */
function parseCustomPalette(raw?: string | null): Palette | null {
  if (!raw || raw.length > 600) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (typeof v !== 'object' || v === null) return null;
    const keys = ['bg', 'main', 'sub', 'text', 'error'] as const;
    if (!keys.every((k) => typeof v[k] === 'string' && HEX.test(v[k] as string))) return null;
    return { bg: v.bg as string, main: v.main as string, sub: v.sub as string, text: v.text as string, error: v.error as string };
  } catch {
    return null;
  }
}

/**
 * The email theme for a user's saved `interface.theme` (+ `customTheme` when it is 'custom').
 * Unknown ids and malformed custom themes fall back to dark.
 */
export function resolveEmailTheme(theme?: string | null, customTheme?: string | null): EmailTheme {
  if (theme && THEMES[theme]) return THEMES[theme];
  if (theme === 'custom') {
    const p = parseCustomPalette(customTheme);
    if (p) return deriveEmailTheme(p);
  }
  const pal = theme ? EMAIL_PALETTES[theme] : undefined;
  if (pal) return deriveEmailTheme({ bg: pal[0], main: pal[1], sub: pal[2], text: pal[3], error: pal[4] });
  return THEMES.dark;
}
