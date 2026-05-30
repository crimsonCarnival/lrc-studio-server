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
      username: { type: 'string', minLength: 3, maxLength: 30, pattern: '^[a-z0-9_.:-]+$' },
      email: { type: 'string', format: 'email', maxLength: 254 },
      password: { type: 'string', minLength: 8, maxLength: 128 },
      recaptchaToken: { type: 'string', minLength: 1, maxLength: 8192 },
    },
    required: ['password'],
    anyOf: [{ required: ['username'] }, { required: ['email'] }],
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

export const updateProfileSchema = {
  body: {
    type: 'object',
    properties: {
      avatarUrl: { type: ['string', 'null'], maxLength: 500 },
      avatarPublicId: { type: ['string', 'null'], maxLength: 500 },
      username: { type: 'string', minLength: 3, maxLength: 30, pattern: '^[a-z0-9_.:-]+$' },
      email: { type: 'string', format: 'email', maxLength: 254 },
      bio: { type: 'string', maxLength: 160 },
    },
    additionalProperties: false,
  },
};