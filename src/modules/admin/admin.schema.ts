export const userIdParam = {
  type: 'object',
  properties: { id: { type: 'string', minLength: 1, maxLength: 24 } },
  required: ['id'],
};

export const banUserSchema = {
  body: {
    type: 'object',
    properties: {
      reason: { type: 'string', maxLength: 1000 },
      bannedUntil: { type: ['string', 'null'], format: 'date-time' },
      banIp: { type: 'boolean' },
      banDevice: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  params: userIdParam,
};

export const changeRoleSchema = {
  body: {
    type: 'object',
    properties: {
      role: { type: 'string', enum: ['user', 'mod', 'admin', 'superadmin'] },
    },
    required: ['role'],
    additionalProperties: false,
  },
  params: userIdParam,
};

export const blockIpSchema = {
  body: {
    type: 'object',
    properties: {
      ip: { type: 'string', minLength: 7, maxLength: 45 },
      reason: { type: 'string', maxLength: 500 },
    },
    required: ['ip'],
    additionalProperties: false,
  },
};

export const blockDeviceSchema = {
  body: {
    type: 'object',
    properties: {
      deviceId: { type: 'string', minLength: 1, maxLength: 128 },
      reason: { type: 'string', maxLength: 500 },
    },
    required: ['deviceId'],
    additionalProperties: false,
  },
};

export const listUsersSchema = {
  querystring: {
    type: 'object',
    properties: {
      cursor: { type: 'string', maxLength: 24 },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
      search: { type: 'string', maxLength: 200 },
      role: { type: 'string' },
      status: { type: 'string', enum: ['', 'all', 'active', 'banned', 'pending', 'deleted', 'verified', 'premium'] },
    },
  },
};

export const listLogsSchema = {
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'integer', minimum: 1, default: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
    },
  },
};

export const idParam = {
  type: 'object',
  properties: { id: { type: 'string', minLength: 1, maxLength: 24 } },
  required: ['id'],
};