import nodemailer from 'nodemailer';

function getTransporter() {
  return nodemailer.createTransport({
    host: 'smtp-relay.brevo.com',
    port: 587,
    secure: false,
    requireTLS: true,
    auth: {
      user: process.env.BREVO_SMTP_USER,
      pass: process.env.BREVO_SMTP_KEY,
    },
  });
}

export async function sendPasswordResetEmail(
  email: string,
  resetLink: string,
  userName?: string
): Promise<void> {
  const appName = process.env.APP_NAME || 'LRC Studio';

  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <link href="https://fonts.googleapis.com/css2?family=Stack+Sans+Notch:wght@500;700&family=Fira+Sans:wght@400;500;600&display=swap" rel="stylesheet">
      <style>
        body {
          margin: 0;
          padding: 0;
          font-family: 'Fira Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          background: linear-gradient(135deg, #09090b 0%, #18181b 100%);
          color: #f4f4f5;
        }
        .container {
          max-width: 600px;
          margin: 0 auto;
          background: #18181b;
          border: 1px solid #3f3f46;
          border-radius: 12px;
          overflow: hidden;
          box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.3);
        }
        .header {
          background: linear-gradient(135deg, #1a1a1f 0%, #27272a 100%);
          padding: 32px 24px;
          border-bottom: 1px solid #3f3f46;
          text-align: center;
          position: relative;
          overflow: hidden;
        }
        .header::before {
          content: '';
          position: absolute;
          top: -50%;
          right: -50%;
          width: 300px;
          height: 300px;
          background: radial-gradient(circle, rgba(29, 185, 84, 0.1) 0%, transparent 70%);
          border-radius: 50%;
        }
        .header-content {
          position: relative;
          z-index: 1;
        }
        .logo-text {
          font-family: 'Stack Sans Notch', sans-serif;
          font-size: 24px;
          font-weight: 700;
          color: #1DB954;
          margin: 0;
          letter-spacing: -0.5px;
        }
        .content {
          padding: 40px 24px;
        }
        .greeting {
          font-size: 18px;
          font-weight: 600;
          color: #f4f4f5;
          margin: 0 0 8px 0;
        }
        .subheading {
          font-size: 14px;
          color: #a1a1a6;
          margin: 0 0 24px 0;
          line-height: 1.6;
        }
        .message {
          font-size: 14px;
          color: #d4d4d8;
          margin: 0 0 32px 0;
          line-height: 1.8;
        }
        .button-container {
          text-align: center;
          margin: 40px 0;
        }
        .button {
          background: linear-gradient(135deg, #1DB954 0%, #1aa34a 100%);
          color: #09090b;
          padding: 14px 48px;
          text-decoration: none;
          border-radius: 8px;
          display: inline-block;
          font-weight: 600;
          font-size: 15px;
          letter-spacing: 0.5px;
          box-shadow: 0 4px 12px rgba(29, 185, 84, 0.25);
        }
        .info-box {
          background: rgba(29, 185, 84, 0.05);
          border: 1px solid rgba(29, 185, 84, 0.2);
          border-radius: 8px;
          padding: 16px 20px;
          margin: 24px 0;
        }
        .info-box-title {
          font-size: 13px;
          font-weight: 600;
          color: #1DB954;
          margin: 0 0 6px 0;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .info-box-text {
          font-size: 13px;
          color: #a1a1a6;
          margin: 0;
          line-height: 1.6;
        }
        .security-notice {
          background: rgba(245, 158, 11, 0.05);
          border: 1px solid rgba(245, 158, 11, 0.2);
          border-radius: 8px;
          padding: 14px 18px;
          margin: 24px 0;
        }
        .security-notice-text {
          font-size: 12px;
          color: #d4d4d8;
          margin: 0;
          line-height: 1.6;
          font-style: italic;
        }
        .footer {
          background: #09090b;
          border-top: 1px solid #3f3f46;
          padding: 24px;
          text-align: center;
        }
        .footer-text {
          font-size: 12px;
          color: #71717a;
          margin: 0;
          line-height: 1.6;
        }
        .footer-brand {
          font-family: 'Stack Sans Notch', sans-serif;
          font-weight: 600;
          color: #1DB954;
        }
        @media (max-width: 600px) {
          .container { border-radius: 0; }
          .content { padding: 24px 16px; }
          .button { padding: 12px 32px; font-size: 14px; }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div class="header-content">
            <p class="logo-text">${appName}</p>
          </div>
        </div>
        <div class="content">
          <p class="greeting">Reset Your Password</p>
          <p class="subheading">Hello${userName ? ` ${userName}` : ''},</p>
          <p class="message">You requested a password reset. Click the button below to create a new password:</p>
          <div class="button-container">
            <a href="${resetLink}" class="button">Reset Password</a>
          </div>
          <div class="info-box">
            <p class="info-box-title">⏱️ Link Expires Soon</p>
            <p class="info-box-text">This reset link is valid for 30 minutes. After that, you'll need to request a new one.</p>
          </div>
          <div class="security-notice">
            <p class="security-notice-text">💡 Didn't request this? If you didn't ask for a password reset, you can safely ignore this email. Your account remains secure.</p>
          </div>
        </div>
        <div class="footer">
          <p class="footer-text">
            © ${new Date().getFullYear()} <span class="footer-brand">${appName}</span><br>
            Keep your credentials safe. Never share this link with anyone.
          </p>
        </div>
      </div>
    </body>
    </html>
  `;

  await getTransporter().sendMail({
    from: process.env.EMAIL_FROM || `LRC Studio <${process.env.BREVO_SMTP_USER}>`,
    to: email,
    subject: `Reset Your ${appName} Password`,
    html,
  });
}

export async function sendVerificationEmail(
  email: string,
  verifyLink: string,
  userName?: string
): Promise<void> {
  const appName = process.env.APP_NAME || 'LRC Studio';

  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <link href="https://fonts.googleapis.com/css2?family=Stack+Sans+Notch:wght@500;700&family=Fira+Sans:wght@400;500;600&display=swap" rel="stylesheet">
      <style>
        body {
          margin: 0;
          padding: 0;
          font-family: 'Fira Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          background: linear-gradient(135deg, #09090b 0%, #18181b 100%);
          color: #f4f4f5;
        }
        .container {
          max-width: 600px;
          margin: 0 auto;
          background: #18181b;
          border: 1px solid #3f3f46;
          border-radius: 12px;
          overflow: hidden;
          box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.3);
        }
        .header {
          background: linear-gradient(135deg, #1a1a1f 0%, #27272a 100%);
          padding: 32px 24px;
          border-bottom: 1px solid #3f3f46;
          text-align: center;
          position: relative;
          overflow: hidden;
        }
        .header::before {
          content: '';
          position: absolute;
          top: -50%;
          right: -50%;
          width: 300px;
          height: 300px;
          background: radial-gradient(circle, rgba(29, 185, 84, 0.1) 0%, transparent 70%);
          border-radius: 50%;
        }
        .header-content {
          position: relative;
          z-index: 1;
        }
        .logo-text {
          font-family: 'Stack Sans Notch', sans-serif;
          font-size: 24px;
          font-weight: 700;
          color: #1DB954;
          margin: 0;
          letter-spacing: -0.5px;
        }
        .content {
          padding: 40px 24px;
        }
        .greeting {
          font-size: 18px;
          font-weight: 600;
          color: #f4f4f5;
          margin: 0 0 8px 0;
        }
        .subheading {
          font-size: 14px;
          color: #a1a1a6;
          margin: 0 0 24px 0;
          line-height: 1.6;
        }
        .message {
          font-size: 14px;
          color: #d4d4d8;
          margin: 0 0 32px 0;
          line-height: 1.8;
        }
        .button-container {
          text-align: center;
          margin: 40px 0;
        }
        .button {
          background: linear-gradient(135deg, #1DB954 0%, #1aa34a 100%);
          color: #09090b;
          padding: 14px 48px;
          text-decoration: none;
          border-radius: 8px;
          display: inline-block;
          font-weight: 600;
          font-size: 15px;
          letter-spacing: 0.5px;
          box-shadow: 0 4px 12px rgba(29, 185, 84, 0.25);
        }
        .info-box {
          background: rgba(29, 185, 84, 0.05);
          border: 1px solid rgba(29, 185, 84, 0.2);
          border-radius: 8px;
          padding: 16px 20px;
          margin: 24px 0;
        }
        .info-box-title {
          font-size: 13px;
          font-weight: 600;
          color: #1DB954;
          margin: 0 0 6px 0;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .info-box-text {
          font-size: 13px;
          color: #a1a1a6;
          margin: 0;
          line-height: 1.6;
        }
        .security-notice {
          background: rgba(245, 158, 11, 0.05);
          border: 1px solid rgba(245, 158, 11, 0.2);
          border-radius: 8px;
          padding: 14px 18px;
          margin: 24px 0;
        }
        .security-notice-text {
          font-size: 12px;
          color: #d4d4d8;
          margin: 0;
          line-height: 1.6;
          font-style: italic;
        }
        .footer {
          background: #09090b;
          border-top: 1px solid #3f3f46;
          padding: 24px;
          text-align: center;
        }
        .footer-text {
          font-size: 12px;
          color: #71717a;
          margin: 0;
          line-height: 1.6;
        }
        .footer-brand {
          font-family: 'Stack Sans Notch', sans-serif;
          font-weight: 600;
          color: #1DB954;
        }
        @media (max-width: 600px) {
          .container { border-radius: 0; }
          .content { padding: 24px 16px; }
          .button { padding: 12px 32px; font-size: 14px; }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div class="header-content">
            <p class="logo-text">${appName}</p>
          </div>
        </div>
        <div class="content">
          <p class="greeting">Verify Your Email Address</p>
          <p class="subheading">Hello${userName ? ` ${userName}` : ''},</p>
          <p class="message">Click the button below to verify your email address:</p>
          <div class="button-container">
            <a href="${verifyLink}" class="button">Verify Email Address</a>
          </div>
          <div class="info-box">
            <p class="info-box-title">⏱️ Link Expires in 24 Hours</p>
            <p class="info-box-text">This verification link is valid for 24 hours. After that, you can request a new one from your account settings.</p>
          </div>
          <div class="security-notice">
            <p class="security-notice-text">💡 Didn't request this? If you didn't ask to verify this email, you can safely ignore it. Your account remains secure.</p>
          </div>
        </div>
        <div class="footer">
          <p class="footer-text">
            © ${new Date().getFullYear()} <span class="footer-brand">${appName}</span><br>
            Keep your credentials safe. Never share this link with anyone.
          </p>
        </div>
      </div>
    </body>
    </html>
  `;

  await getTransporter().sendMail({
    from: process.env.EMAIL_FROM || `LRC Studio <${process.env.BREVO_SMTP_USER}>`,
    to: email,
    subject: `Verify Your ${appName} Email`,
    html,
  });
}

export async function sendBanEmail(
  email: string,
  reason: string | null,
  userName?: string
): Promise<void> {
  const appName = process.env.APP_NAME || 'LRC Studio';
  const reasonBlock = reason
    ? `<blockquote style="border-left:3px solid #ef4444;padding:8px 16px;margin:16px 0;color:#fca5a5">${reason}</blockquote>`
    : '';
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
    <style>body{margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#09090b;color:#f4f4f5}
    .container{max-width:600px;margin:0 auto;background:#18181b;border:1px solid #3f3f46;border-radius:12px;overflow:hidden}
    .header{background:#27272a;padding:32px 24px;border-bottom:1px solid #3f3f46;text-align:center}
    .body{padding:32px 24px}.footer{padding:16px 24px;border-top:1px solid #3f3f46;text-align:center;color:#71717a;font-size:12px}</style>
    </head><body><div class="container">
    <div class="header"><h1 style="margin:0;font-size:20px;color:#f4f4f5">${appName}</h1></div>
    <div class="body">
      <p>Hi ${userName || 'there'},</p>
      <p>Your account has been suspended${reason ? ' for the following reason:' : '.'}</p>
      ${reasonBlock}
      <p>If you believe this is an error, you can submit an appeal from the app.</p>
    </div>
    <div class="footer">${appName} — Automated security notification.</div>
    </div></body></html>`;

  await getTransporter().sendMail({
    from: process.env.EMAIL_FROM || `LRC Studio <${process.env.BREVO_SMTP_USER}>`,
    to: email,
    subject: `Your ${appName} account has been suspended`,
    html,
  });
}

export async function sendPasswordChangedEmail(
  email: string,
  userName?: string
): Promise<void> {
  const appName = process.env.APP_NAME || 'LRC Studio';
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
    <style>body{margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#09090b;color:#f4f4f5}
    .container{max-width:600px;margin:0 auto;background:#18181b;border:1px solid #3f3f46;border-radius:12px;overflow:hidden}
    .header{background:#27272a;padding:32px 24px;border-bottom:1px solid #3f3f46;text-align:center}
    .body{padding:32px 24px}.footer{padding:16px 24px;border-top:1px solid #3f3f46;text-align:center;color:#71717a;font-size:12px}</style>
    </head><body><div class="container">
    <div class="header"><h1 style="margin:0;font-size:20px;color:#f4f4f5">${appName}</h1></div>
    <div class="body">
      <p>Hi ${userName || 'there'},</p>
      <p>Your password was recently changed. If you made this change, no action is needed.</p>
      <p>If you did not change your password, please reset it immediately from the login page.</p>
    </div>
    <div class="footer">${appName} — Automated security notification.</div>
    </div></body></html>`;

  await getTransporter().sendMail({
    from: process.env.EMAIL_FROM || `LRC Studio <${process.env.BREVO_SMTP_USER}>`,
    to: email,
    subject: `Your ${appName} password was changed`,
    html,
  });
}
