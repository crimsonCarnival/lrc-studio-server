import { describe, it, expect, beforeAll, vi } from 'vitest';
import { v2 as cloudinary } from 'cloudinary';

vi.mock('../auth/auth.service.js', () => ({ verifyRecaptcha: async () => true }));

import { generateAudioSignature } from './uploads.service.js';

beforeAll(() => {
  process.env.CLOUDINARY_CLOUD_NAME = 'demo';
  process.env.CLOUDINARY_API_KEY = 'key';
  process.env.CLOUDINARY_API_SECRET = 'secret';
});

const sign = (fileName: string) =>
  generateAudioSignature({ fileName, fileSize: 1024 }, 'user1', '127.0.0.1') as Promise<Record<string, unknown>>;

describe('generateAudioSignature transcoding', () => {
  it('signs an AAC transcode for lossless input, so the client cannot drop it', async () => {
    const res = await sign('song.wav');
    expect(res).toMatchObject({ format: 'm4a', transformation: 'ac_aac,br_128k' });
    const expected = cloudinary.utils.api_sign_request({
      timestamp: res.timestamp as number,
      folder: res.folder as string,
      allowed_formats: res.allowedFormats as string,
      format: 'm4a',
      transformation: 'ac_aac,br_128k',
    }, 'secret');
    expect(res.signature).toBe(expected);
  });

  it('stores already-compressed browser formats untouched', async () => {
    const res = await sign('song.mp3');
    expect(res.format).toBeUndefined();
    expect(res.transformation).toBeUndefined();
  });
});
