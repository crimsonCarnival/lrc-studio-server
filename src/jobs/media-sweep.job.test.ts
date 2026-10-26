import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import User from '../db/user.model.js';
import Playlist from '../db/playlist.model.js';
import Activity from '../db/activity.model.js';
import Notification from '../modules/notifications/notification.model.js';
import Project from '../modules/projects/project.model.js';
import Upload from '../modules/uploads/upload.model.js';
import { sweepOrphanedMedia, assetIdFromReference, type MediaStore, type StoredAsset } from './media-sweep.job.js';

let mongo: MongoMemoryServer;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  await Promise.all([User, Playlist, Activity, Notification, Project, Upload].map((m) => m.collection.deleteMany({})));
});

const NOW = new Date('2026-10-26T12:00:00.000Z');
const OLD = new Date(NOW.getTime() - 30 * 86400000);
const FRESH = new Date(NOW.getTime() - 60 * 60 * 1000);
const url = (id: string, ext = 'webp') => `https://res.cloudinary.com/demo/image/upload/c_limit,w_1024/v1700000000/${id}.${ext}`;

function fakeStore(assets: Record<'image' | 'video', StoredAsset[]>) {
  const destroyed: string[] = [];
  const store: MediaStore = {
    async *list(prefix, resourceType) {
      for (const a of assets[resourceType]) if (a.publicId.startsWith(prefix)) yield a;
    },
    async destroy(ids) { destroyed.push(...ids); },
  };
  return { store, destroyed };
}

// Enough referenced filler that a handful of orphans stays under the safety fraction.
async function referencedFiller(n: number): Promise<StoredAsset[]> {
  const assets: StoredAsset[] = [];
  for (let i = 0; i < n; i++) {
    const id = `lyrics-syncer/covers/u/filler${i}`;
    await Playlist.collection.insertOne({ name: `p${i}`, coverImage: url(id) });
    assets.push({ publicId: id, createdAt: OLD });
  }
  return assets;
}

describe('assetIdFromReference', () => {
  it('strips host, transformations, version and extension', () => {
    expect(assetIdFromReference(url('lyrics-syncer/covers/u/abc'))).toBe('lyrics-syncer/covers/u/abc');
  });
  it('keeps a bare public id as is', () => {
    expect(assetIdFromReference('lyrics-syncer/audio/u/song')).toBe('lyrics-syncer/audio/u/song');
  });
  it('ignores URLs outside our folder', () => {
    expect(assetIdFromReference('https://i.ytimg.com/vi/abc/hqdefault.jpg')).toBeNull();
  });
});

describe('sweepOrphanedMedia', () => {
  it('deletes only old assets that nothing references', async () => {
    const filler = await referencedFiller(6);
    await Project.collection.insertOne({ publicId: 'p1', coverImage: url('lyrics-syncer/covers/u/kept') });
    await Upload.collection.insertOne({ source: 'cloudinary', publicId: 'lyrics-syncer/audio/u/song' });
    const { store, destroyed } = fakeStore({
      image: [
        ...filler,
        { publicId: 'lyrics-syncer/covers/u/kept', createdAt: OLD },
        { publicId: 'lyrics-syncer/covers/u/replaced', createdAt: OLD },
        { publicId: 'lyrics-syncer/covers/u/just-uploaded', createdAt: FRESH },
      ],
      video: [
        { publicId: 'lyrics-syncer/audio/u/song', createdAt: OLD },
        { publicId: 'lyrics-syncer/audio/u/abandoned', createdAt: OLD },
      ],
    });

    const result = await sweepOrphanedMedia(store, { now: NOW, deleteEnabled: true });

    expect(destroyed.sort()).toEqual(['lyrics-syncer/audio/u/abandoned', 'lyrics-syncer/covers/u/replaced']);
    expect(result.deleted).toBe(2);
  });

  it('keeps a cover still shown by a fork, an activity entry or a notification', async () => {
    const filler = await referencedFiller(6);
    await Project.collection.insertOne({ publicId: 'fork', coverImage: url('lyrics-syncer/covers/u/forked') });
    await Activity.collection.insertOne({ type: 'project_published', coverImage: url('lyrics-syncer/covers/u/in-feed') });
    await Notification.collection.insertOne({ type: 'follow', avatarUrl: url('lyrics-syncer/avatars/u/old-face') });
    const { store, destroyed } = fakeStore({
      image: [
        ...filler,
        { publicId: 'lyrics-syncer/covers/u/forked', createdAt: OLD },
        { publicId: 'lyrics-syncer/covers/u/in-feed', createdAt: OLD },
        { publicId: 'lyrics-syncer/avatars/u/old-face', createdAt: OLD },
      ],
      video: [],
    });

    const result = await sweepOrphanedMedia(store, { now: NOW, deleteEnabled: true });
    // orphaned, not just destroyed: the safety guard alone would also leave destroyed empty.
    expect(result.orphaned).toBe(0);
    expect(destroyed).toEqual([]);
  });

  it('only reports in dry-run mode', async () => {
    const filler = await referencedFiller(4);
    const { store, destroyed } = fakeStore({
      image: [...filler, { publicId: 'lyrics-syncer/covers/u/orphan', createdAt: OLD }],
      video: [],
    });

    const result = await sweepOrphanedMedia(store, { now: NOW });
    expect(result).toMatchObject({ orphaned: 1, deleted: 0, skipped: 'dry_run' });
    expect(destroyed).toEqual([]);
  });

  it('refuses to delete when most assets look orphaned', async () => {
    const { store, destroyed } = fakeStore({
      image: [
        { publicId: 'lyrics-syncer/covers/u/a', createdAt: OLD },
        { publicId: 'lyrics-syncer/covers/u/b', createdAt: OLD },
      ],
      video: [],
    });

    const result = await sweepOrphanedMedia(store, { now: NOW, deleteEnabled: true });
    expect(result.skipped).toBe('too_many_orphans');
    expect(destroyed).toEqual([]);
  });
});
