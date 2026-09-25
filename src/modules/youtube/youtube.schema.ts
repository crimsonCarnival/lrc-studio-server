import { YOUTUBE_VIDEO_ID_PATTERN } from './youtube.service.js';

// Shared by GET /availability and the legacy GET /check-embed alias.
export const availabilityQuerySchema = {
  type: 'object',
  required: ['videoId'],
  properties: {
    videoId: { type: 'string', pattern: YOUTUBE_VIDEO_ID_PATTERN },
  },
  additionalProperties: false,
};
