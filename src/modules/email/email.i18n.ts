export type EmailLang = 'en' | 'es' | 'ja';

const VALID_LANGS = new Set<EmailLang>(['en', 'es', 'ja']);

export function resolveEmailLang(lang?: string | null): EmailLang {
  const base = lang?.split('-')[0] as EmailLang;
  return VALID_LANGS.has(base) ? base : 'en';
}

type TranslationMap = Record<string, string>;

const translations: Record<EmailLang, TranslationMap> = {
  en: {
    // shared
    'hello': 'Hello {{name}},',
    'helloAnon': 'Hello,',
    'footerSafety': 'Keep your credentials safe. Never share this link with anyone.',
    'footerAutomated': 'Automated security notification.',
    'securityIgnore': "Didn't request this? You can safely ignore this email. Your account remains secure.",

    // password reset
    'passwordReset.subject': 'Reset Your {{appName}} Password',
    'passwordReset.heading': 'Reset Your Password',
    'passwordReset.body': 'You requested a password reset. Click the button below to create a new password:',
    'passwordReset.cta': 'Reset Password',
    'passwordReset.infoTitle': 'Link Expires Soon',
    'passwordReset.infoText_one': 'This reset link is valid for {{count}} minute. After that, request a new one.',
    'passwordReset.infoText_other': 'This reset link is valid for {{count}} minutes. After that, request a new one.',

    // email verification
    'verification.subject': 'Verify Your {{appName}} Email',
    'verification.heading': 'Verify Your Email Address',
    'verification.body': 'Click the button below to verify your email address:',
    'verification.cta': 'Verify Email Address',
    'verification.infoTitle': 'Link Expires in {{count}} Hours',
    'verification.infoText_one': 'This verification link is valid for {{count}} hour. After that, request a new one from your account settings.',
    'verification.infoText_other': 'This verification link is valid for {{count}} hours. After that, request a new one from your account settings.',

    // ban
    'ban.subject': 'Your {{appName}} account has been suspended',
    'ban.heading': 'Account Suspended',
    'ban.body': 'Your account has been suspended.',
    'ban.bodyWithReason': 'Your account has been suspended for the following reason:',
    'ban.appeal': 'If you believe this is an error, you can submit an appeal from the app.',

    // password changed
    'passwordChanged.subject': 'Your {{appName}} password was changed',
    'passwordChanged.heading': 'Password Changed',
    'passwordChanged.body': 'Your password was recently changed. If you made this change, no action is needed.',
    'passwordChanged.security': 'If you did not change your password, please reset it immediately from the login page.',
  },

  es: {
    'hello': 'Hola {{name}},',
    'helloAnon': 'Hola,',
    'footerSafety': 'Mantén tus credenciales seguras. Nunca compartas este enlace.',
    'footerAutomated': 'Notificación de seguridad automática.',
    'securityIgnore': '¿No solicitaste esto? Puedes ignorar este correo. Tu cuenta permanece segura.',

    'passwordReset.subject': 'Restablece tu contraseña de {{appName}}',
    'passwordReset.heading': 'Restablecer contraseña',
    'passwordReset.body': 'Solicitaste restablecer tu contraseña. Haz clic en el botón para crear una nueva:',
    'passwordReset.cta': 'Restablecer contraseña',
    'passwordReset.infoTitle': 'El enlace expira pronto',
    'passwordReset.infoText_one': 'Este enlace es válido por {{count}} minuto. Después deberás solicitar uno nuevo.',
    'passwordReset.infoText_other': 'Este enlace es válido por {{count}} minutos. Después deberás solicitar uno nuevo.',

    'verification.subject': 'Verifica tu correo de {{appName}}',
    'verification.heading': 'Verifica tu dirección de correo',
    'verification.body': 'Haz clic en el botón para verificar tu dirección de correo:',
    'verification.cta': 'Verificar correo',
    'verification.infoTitle': 'El enlace expira en {{count}} horas',
    'verification.infoText_one': 'Este enlace es válido por {{count}} hora. Después solicita uno nuevo desde tu configuración.',
    'verification.infoText_other': 'Este enlace es válido por {{count}} horas. Después solicita uno nuevo desde tu configuración.',

    'ban.subject': 'Tu cuenta de {{appName}} ha sido suspendida',
    'ban.heading': 'Cuenta suspendida',
    'ban.body': 'Tu cuenta ha sido suspendida.',
    'ban.bodyWithReason': 'Tu cuenta ha sido suspendida por la siguiente razón:',
    'ban.appeal': 'Si crees que esto es un error, puedes presentar una apelación desde la aplicación.',

    'passwordChanged.subject': 'Tu contraseña de {{appName}} fue cambiada',
    'passwordChanged.heading': 'Contraseña cambiada',
    'passwordChanged.body': 'Tu contraseña fue cambiada recientemente. Si realizaste este cambio, no es necesario hacer nada.',
    'passwordChanged.security': 'Si no cambiaste tu contraseña, restablécela de inmediato desde la página de inicio de sesión.',
  },

  ja: {
    'hello': '{{name}} 様、',
    'helloAnon': 'こんにちは、',
    'footerSafety': '認証情報は安全に保管してください。このリンクを他人と共有しないでください。',
    'footerAutomated': '自動セキュリティ通知。',
    'securityIgnore': 'このリクエストに心当たりがない場合は、このメールを無視して構いません。アカウントは安全です。',

    'passwordReset.subject': '{{appName}} パスワードのリセット',
    'passwordReset.heading': 'パスワードをリセット',
    'passwordReset.body': 'パスワードのリセットが要求されました。以下のボタンをクリックして新しいパスワードを設定してください:',
    'passwordReset.cta': 'パスワードをリセット',
    'passwordReset.infoTitle': 'リンクの有効期限が近づいています',
    'passwordReset.infoText_one': 'このリセットリンクは {{count}} 分間有効です。期限後は再度リクエストしてください。',
    'passwordReset.infoText_other': 'このリセットリンクは {{count}} 分間有効です。期限後は再度リクエストしてください。',

    'verification.subject': '{{appName}} メールアドレスの確認',
    'verification.heading': 'メールアドレスを確認',
    'verification.body': '以下のボタンをクリックしてメールアドレスを確認してください:',
    'verification.cta': 'メールアドレスを確認',
    'verification.infoTitle': 'リンクは {{count}} 時間有効です',
    'verification.infoText_one': 'この確認リンクは {{count}} 時間有効です。期限後はアカウント設定から再度リクエストしてください。',
    'verification.infoText_other': 'この確認リンクは {{count}} 時間有効です。期限後はアカウント設定から再度リクエストしてください。',

    'ban.subject': '{{appName}} アカウントが停止されました',
    'ban.heading': 'アカウント停止',
    'ban.body': 'アカウントが停止されました。',
    'ban.bodyWithReason': 'アカウントが以下の理由で停止されました:',
    'ban.appeal': 'これが誤りだと思われる場合は、アプリから異議申し立てを行うことができます。',

    'passwordChanged.subject': '{{appName}} パスワードが変更されました',
    'passwordChanged.heading': 'パスワード変更完了',
    'passwordChanged.body': 'パスワードが最近変更されました。ご自身で変更された場合は、何もする必要はありません。',
    'passwordChanged.security': 'パスワードを変更していない場合は、ログインページから直ちにリセットしてください。',
  },
};

export function t(key: string, lang: EmailLang, vars?: Record<string, string | number>): string {
  const count = typeof vars?.count === 'number' ? vars.count : null;

  let resolvedKey = key;
  if (count !== null) {
    const pluralKey = count === 1 ? `${key}_one` : `${key}_other`;
    if (translations[lang][pluralKey] !== undefined) {
      resolvedKey = pluralKey;
    }
  }

  const template =
    translations[lang][resolvedKey] ??
    translations['en'][resolvedKey] ??
    key;

  if (!vars) return template;

  return template.replace(/\{\{(\w+)\}\}/g, (_, name) => {
    const val = vars[name];
    return val !== undefined ? String(val) : `{{${name}}}`;
  });
}
