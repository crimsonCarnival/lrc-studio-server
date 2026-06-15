const MAX_FILE_SIZE = 50 * 1024 * 1024;

export const signatureSchema = {
  body: {
    type: 'object',
    properties: {
      fileName: { type: 'string', minLength: 1, maxLength: 255 },
      fileSize: { type: 'integer', minimum: 1, maximum: MAX_FILE_SIZE },
      recaptchaToken: { type: 'string', minLength: 1, maxLength: 8192 },
    },
    required: ['fileName', 'fileSize'],
  },
};

export const createMediaSchema = {
  body: {
    type: 'object',
    properties: {
      source: { type: 'string', enum: ['cloudinary', 'youtube', 'spotify'] },
      uploadUrl: { type: ['string', 'null'], maxLength: 500 },
      publicId: { type: ['string', 'null'], maxLength: 500 },
      spotifyTrackId: { type: ['string', 'null'], maxLength: 100 },
      fileName: { type: 'string', maxLength: 500 },
      title: { type: 'string', maxLength: 500 },
      duration: { type: ['number', 'null'] },
    },
    required: ['source'],
    additionalProperties: false,
  },
};

export const updateMediaSchema = {
  body: {
    type: 'object',
    properties: {
      title: { type: 'string', maxLength: 500 },
      fileName: { type: 'string', maxLength: 500 },
      duration: { type: 'number' },
    },
    additionalProperties: false,
  },
};

export const listMediaSchema = {
  querystring: {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
      offset: { type: 'integer', minimum: 0, default: 0 },
    },
  },
};