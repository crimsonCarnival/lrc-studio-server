import { getEmailTheme, type EmailTheme } from './email-themes.js';
import { t, resolveEmailLang, type EmailLang } from './email.i18n.js';

const BREVO_API = 'https://api.brevo.com/v3/smtp/email';

export interface EmailPrefs {
  lang?: string | null;
  theme?: string | null;
}

async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  const apiKey = process.env.BREVO_SMTP_KEY;
  const fromEmail = process.env.BREVO_SMTP_USER;
  const appName = process.env.APP_NAME || 'LRC Studio';

  if (!apiKey || !fromEmail) {
    throw new Error('Brevo credentials not configured (BREVO_SMTP_KEY, BREVO_SMTP_USER)');
  }

  const res = await fetch(BREVO_API, {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { name: appName, email: fromEmail },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Brevo API error ${res.status}: ${body}`);
  }
}

function buildStyles(th: EmailTheme): string {
  return `
    body{margin:0;padding:0;font-family:'Fira Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:${th.bg};color:${th.text}}
    .wrap{max-width:600px;margin:0 auto;background:${th.surface};border:1px solid ${th.border};border-radius:12px;overflow:hidden;box-shadow:0 10px 15px -3px rgba(0,0,0,.3)}
    .hdr{background:${th.surfaceAlt};padding:32px 24px;border-bottom:1px solid ${th.border};text-align:center;position:relative;overflow:hidden}
    .hdr::before{content:'';position:absolute;top:-50%;right:-50%;width:300px;height:300px;background:radial-gradient(circle,${th.primary}1a 0%,transparent 70%);border-radius:50%}
    .hdr-inner{position:relative;z-index:1}
    .logo{font-family:'Stack Sans Notch',sans-serif;font-size:24px;font-weight:700;color:${th.primary};margin:0;letter-spacing:-.5px}
    .body{padding:40px 24px}
    .heading{font-size:18px;font-weight:600;color:${th.text};margin:0 0 8px}
    .subheading{font-size:14px;color:${th.textMuted};margin:0 0 24px;line-height:1.6}
    .message{font-size:14px;color:${th.text};margin:0 0 32px;line-height:1.8}
    .btn-wrap{text-align:center;margin:40px 0}
    .btn{background:linear-gradient(135deg,${th.primary} 0%,${th.primaryDark} 100%);color:${th.primaryContrast};padding:14px 48px;text-decoration:none;border-radius:8px;display:inline-block;font-weight:600;font-size:15px;letter-spacing:.5px;box-shadow:0 4px 12px ${th.primary}40}
    .info{background:${th.infoBg};border:1px solid ${th.infoBorder};border-radius:8px;padding:16px 20px;margin:24px 0}
    .info-title{font-size:13px;font-weight:600;color:${th.info};margin:0 0 6px;text-transform:uppercase;letter-spacing:.5px}
    .info-text{font-size:13px;color:${th.textMuted};margin:0;line-height:1.6}
    .notice{background:${th.warningBg};border:1px solid ${th.warningBorder};border-radius:8px;padding:14px 18px;margin:24px 0}
    .notice-text{font-size:12px;color:${th.text};margin:0;line-height:1.6;font-style:italic}
    .danger{background:${th.dangerBg};border-left:3px solid ${th.danger};padding:8px 16px;margin:16px 0;color:${th.danger};font-size:14px;line-height:1.6}
    .ftr{background:${th.bg};border-top:1px solid ${th.border};padding:24px;text-align:center}
    .ftr-text{font-size:12px;color:${th.textSubtle};margin:0;line-height:1.6}
    .ftr-brand{font-family:'Stack Sans Notch',sans-serif;font-weight:600;color:${th.primary}}
    @media(max-width:600px){.wrap{border-radius:0}.body{padding:24px 16px}.btn{padding:12px 32px;font-size:14px}}
  `;
}

interface RenderOpts {
  th: EmailTheme;
  lang: EmailLang;
  appName: string;
  heading: string;
  subheading: string;
  bodyHtml: string;
  ctaHref?: string;
  ctaLabel?: string;
  infoTitle?: string;
  infoText?: string;
  noticeText?: string;
  footerLine?: string;
}

function renderEmail(opts: RenderOpts): string {
  const { th, lang, appName, heading, subheading, bodyHtml, ctaHref, ctaLabel, infoTitle, infoText, noticeText, footerLine } = opts;

  const ctaBlock = ctaHref && ctaLabel
    ? `<div class="btn-wrap"><a href="${ctaHref}" class="btn">${ctaLabel}</a></div>`
    : '';

  const infoBlock = infoTitle && infoText
    ? `<div class="info"><p class="info-title">${infoTitle}</p><p class="info-text">${infoText}</p></div>`
    : '';

  const noticeBlock = noticeText
    ? `<div class="notice"><p class="notice-text">${noticeText}</p></div>`
    : '';

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <link href="https://fonts.googleapis.com/css2?family=Stack+Sans+Notch:wght@500;700&family=Fira+Sans:wght@400;500;600&display=swap" rel="stylesheet">
  <style>${buildStyles(th)}</style>
</head>
<body>
  <div class="wrap">
    <div class="hdr">
      <div class="hdr-inner"><p class="logo">${appName}</p></div>
    </div>
    <div class="body">
      <p class="heading">${heading}</p>
      <p class="subheading">${subheading}</p>
      ${bodyHtml}
      ${ctaBlock}
      ${infoBlock}
      ${noticeBlock}
    </div>
    <div class="ftr">
      <p class="ftr-text">
        &copy; ${new Date().getFullYear()} <span class="ftr-brand">${appName}</span><br>
        ${footerLine ?? ''}
      </p>
    </div>
  </div>
</body>
</html>`;
}

export async function sendPasswordResetEmail(
  email: string,
  resetLink: string,
  userName?: string,
  prefs?: EmailPrefs
): Promise<void> {
  const appName = process.env.APP_NAME || 'LRC Studio';
  const lang = resolveEmailLang(prefs?.lang);
  const th = getEmailTheme(prefs?.theme);

  const html = renderEmail({
    th, lang, appName,
    heading: t('passwordReset.heading', lang),
    subheading: userName ? t('hello', lang, { name: userName }) : t('helloAnon', lang),
    bodyHtml: `<p class="message">${t('passwordReset.body', lang)}</p>`,
    ctaHref: resetLink,
    ctaLabel: t('passwordReset.cta', lang),
    infoTitle: t('passwordReset.infoTitle', lang),
    infoText: t('passwordReset.infoText', lang, { count: 30 }),
    noticeText: t('securityIgnore', lang),
    footerLine: t('footerSafety', lang),
  });

  await sendEmail(email, t('passwordReset.subject', lang, { appName }), html);
}

export async function sendVerificationEmail(
  email: string,
  verifyLink: string,
  userName?: string,
  prefs?: EmailPrefs
): Promise<void> {
  const appName = process.env.APP_NAME || 'LRC Studio';
  const lang = resolveEmailLang(prefs?.lang);
  const th = getEmailTheme(prefs?.theme);

  const html = renderEmail({
    th, lang, appName,
    heading: t('verification.heading', lang),
    subheading: userName ? t('hello', lang, { name: userName }) : t('helloAnon', lang),
    bodyHtml: `<p class="message">${t('verification.body', lang)}</p>`,
    ctaHref: verifyLink,
    ctaLabel: t('verification.cta', lang),
    infoTitle: t('verification.infoTitle', lang, { count: 24 }),
    infoText: t('verification.infoText', lang, { count: 24 }),
    noticeText: t('securityIgnore', lang),
    footerLine: t('footerSafety', lang),
  });

  await sendEmail(email, t('verification.subject', lang, { appName }), html);
}

export async function sendBanEmail(
  email: string,
  reason: string | null,
  userName?: string,
  prefs?: EmailPrefs
): Promise<void> {
  const appName = process.env.APP_NAME || 'LRC Studio';
  const lang = resolveEmailLang(prefs?.lang);
  const th = getEmailTheme(prefs?.theme);

  const reasonBlock = reason
    ? `<div class="danger">${reason}</div>`
    : '';

  const bodyKey = reason ? 'ban.bodyWithReason' : 'ban.body';

  const html = renderEmail({
    th, lang, appName,
    heading: t('ban.heading', lang),
    subheading: userName ? t('hello', lang, { name: userName }) : t('helloAnon', lang),
    bodyHtml: `<p class="message">${t(bodyKey, lang)}</p>${reasonBlock}<p class="message">${t('ban.appeal', lang)}</p>`,
    footerLine: t('footerAutomated', lang),
  });

  await sendEmail(email, t('ban.subject', lang, { appName }), html);
}

export async function sendPasswordChangedEmail(
  email: string,
  userName?: string,
  prefs?: EmailPrefs
): Promise<void> {
  const appName = process.env.APP_NAME || 'LRC Studio';
  const lang = resolveEmailLang(prefs?.lang);
  const th = getEmailTheme(prefs?.theme);

  const html = renderEmail({
    th, lang, appName,
    heading: t('passwordChanged.heading', lang),
    subheading: userName ? t('hello', lang, { name: userName }) : t('helloAnon', lang),
    bodyHtml: `
      <p class="message">${t('passwordChanged.body', lang)}</p>
      <div class="notice"><p class="notice-text">${t('passwordChanged.security', lang)}</p></div>
    `,
    footerLine: t('footerAutomated', lang),
  });

  await sendEmail(email, t('passwordChanged.subject', lang, { appName }), html);
}
