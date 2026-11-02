/**
 * Auth module — request validation schemas.
 */

export const registerSchema = {
  headers: {
    type: 'object',
    properties: {
      'x-device-id': { type: 'string', minLength: 1, maxLength: 256 },
    },
    required: ['x-device-id'],
  },
  body: {
    type: 'object',
    properties: {
      accountName: { type: 'string', minLength: 3, maxLength: 30, pattern: '^[a-z0-9_.:-]+$' },
      displayName: { type: 'string', maxLength: 50 },
      email: { type: 'string', format: 'email', maxLength: 254 },
      password: { type: 'string', minLength: 8, maxLength: 128 },
      recaptchaToken: { type: 'string', minLength: 1, maxLength: 8192 },
      // Attribution captured client-side pre-registration. Allowlisted free text,
      // not an enum: `ref`/utm values come from external links we don't control.
      signupSource: {
        type: 'object',
        properties: {
          ref: { type: 'string', minLength: 1, maxLength: 64 },
          utmSource: { type: 'string', minLength: 1, maxLength: 64 },
          utmMedium: { type: 'string', minLength: 1, maxLength: 64 },
          utmCampaign: { type: 'string', minLength: 1, maxLength: 64 },
        },
        additionalProperties: false,
      },
    },
    // accountName is mandatory, not one-of-two with email: `/:accountName` is
    // the profile URL and every project URL is owner-scoped under it, so an
    // email-only account could not be addressed at all. Login still accepts
    // either identifier — see loginSchema.
    required: ['accountName', 'password'],
  },
};

export const checkIdentifierSchema = {
  headers: {
    type: 'object',
    properties: {
      'x-device-id': { type: 'string', minLength: 1, maxLength: 256 },
    },
    required: ['x-device-id'],
  },
  body: {
    type: 'object',
    properties: {
      identifier: { type: 'string', minLength: 1, maxLength: 254 },
    },
    required: ['identifier'],
    additionalProperties: false,
  },
};

export const loginSchema = {
  headers: {
    type: 'object',
    properties: {
      'x-device-id': { type: 'string', minLength: 1, maxLength: 256 },
    },
    required: ['x-device-id'],
  },
  body: {
    type: 'object',
    properties: {
      identifier: { type: 'string', minLength: 1, maxLength: 254 },
      password: { type: 'string', minLength: 1, maxLength: 128 },
      recaptchaToken: { type: 'string', minLength: 1, maxLength: 8192 },
    },
    required: ['identifier', 'password'],
  },
};

export const refreshSchema = {
  headers: {
    type: 'object',
    properties: {
      'x-device-id': { type: 'string', minLength: 1, maxLength: 256 },
    },
    required: ['x-device-id'],
  },
  // The refresh token is read from the httpOnly `refreshToken` cookie in the
  // controller — never from the body. Requiring it in the body rejected every
  // real (cookie-based) refresh with 400 before the handler ran, which forced a
  // logout as soon as the access token expired. Body is optional/ignored.
  body: {
    type: 'object',
    properties: {
      refreshToken: { type: 'string', minLength: 1, maxLength: 2048 },
    },
  },
};


// Bodies below were read by hand in the controllers with no route schema. These bound
// types and sizes only: missing-field and password-policy checks stay in the
// controllers/services so the specific error codes the client maps keep working.
const passwordField = { type: 'string', maxLength: 128 };

export const forgotPasswordSchema = {
  body: {
    type: 'object',
    properties: {
      email: { type: 'string', maxLength: 254 },
      recaptchaToken: { type: 'string', maxLength: 8192 },
    },
  },
};

export const validateResetTokenSchema = {
  querystring: {
    type: 'object',
    properties: { token: { type: 'string', maxLength: 512 } },
  },
};

export const resetPasswordSchema = {
  body: {
    type: 'object',
    properties: {
      token: { type: 'string', maxLength: 512 },
      newPassword: passwordField,
      confirmPassword: passwordField,
    },
  },
};

export const changePasswordSchema = {
  body: {
    type: 'object',
    properties: {
      currentPassword: passwordField,
      newPassword: passwordField,
      confirmPassword: passwordField,
    },
  },
};

export const setPasswordSchema = {
  body: {
    type: 'object',
    properties: {
      newPassword: passwordField,
      confirmPassword: passwordField,
    },
  },
};

export const verifyEmailSchema = {
  body: {
    type: 'object',
    properties: { token: { type: 'string', maxLength: 512 } },
  },
};

export const appealSchema = {
  body: {
    type: 'object',
    // Matches the 1000-char cap on User.appeal.text.
    properties: { appealText: { type: 'string', minLength: 1, maxLength: 1000 } },
    required: ['appealText'],
  },
};

export const logoutAllSchema = {
  body: {
    type: ['object', 'null'],
    properties: { keepCurrent: { type: 'boolean' } },
  },
};
