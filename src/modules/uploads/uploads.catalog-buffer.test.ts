import { beforeEach, describe, expect, it, vi } from 'vitest';

const upload = vi.hoisted(() => vi.fn());
vi.mock('cloudinary', () => ({ v2: { config: vi.fn(), uploader: { upload }, utils: {} } }));

import { uploadCatalogImageBuffer } from './uploads.service.js';

const ADMIN = '64b000000000000000000001';
const GOOD = `https://res.cloudinary.com/democloud/image/upload/c_fill,w_600,h_600,f_webp,q_auto/v1/catalog/${ADMIN}/x.webp`;

beforeEach(() => {
  upload.mockReset();
  vi.stubEnv('CLOUDINARY_CLOUD_NAME', 'democloud');
  vi.stubEnv('CLOUDINARY_API_KEY', 'k');
  vi.stubEnv('CLOUDINARY_API_SECRET', 's');
});

describe('uploadCatalogImageBuffer', () => {
  it('uploads to the admin catalog folder with the catalog transformation', async () => {
    upload.mockResolvedValue({ secure_url: GOOD });
    expect(await uploadCatalogImageBuffer(Buffer.from([1, 2]), 'image/png', ADMIN)).toBe(GOOD);
    expect(upload).toHaveBeenCalledWith(`data:image/png;base64,${Buffer.from([1, 2]).toString('base64')}`, {
      folder: `catalog/${ADMIN}`,
      transformation: 'c_fill,w_600,h_600,f_webp,q_auto',
      resource_type: 'image',
    });
  });
  it('throws when storage is unconfigured', async () => {
    vi.stubEnv('CLOUDINARY_API_SECRET', '');
    await expect(uploadCatalogImageBuffer(Buffer.from([1]), 'image/png', ADMIN)).rejects.toThrow('storage_unconfigured');
    expect(upload).not.toHaveBeenCalled();
  });
  it('rejects a result that fails the catalog URL guard', async () => {
    upload.mockResolvedValue({ secure_url: 'https://evil.test/a.png' });
    await expect(uploadCatalogImageBuffer(Buffer.from([1]), 'image/png', ADMIN)).rejects.toThrow('storage_bad_url');
    upload.mockResolvedValue({ secure_url: GOOD });
    await expect(uploadCatalogImageBuffer(Buffer.from([1]), 'image/png', '64b000000000000000000002')).rejects.toThrow('storage_bad_url');
  });
});
