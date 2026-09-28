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
