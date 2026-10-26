/**
 * media-sweep.job.ts
 *
 * Deletes Cloudinary assets that nothing in the database points at any more.
 *
 * Why this exists: only avatars (on replace) and media deleted through
 * deleteMedia are removed from Cloudinary inline. Replaced project, playlist
 * and profile covers, uploads abandoned before saveMedia ran, and the files of
 * archived users all stay stored forever.
 *
 * Why a sweep and not a delete on every replace: a cover URL is copied, not
 * owned — forks clone the source's coverImage, activity entries snapshot it,
 * notifications snapshot the actor's avatar. Deleting on replace would need a
 * reference check at every write site anyway; checking every reference in one
 * place is the same check without the five call sites, and it also catches
 * uploads that were never saved at all.
 *
 * Safety:
 * - Assets are listed BEFORE references are read, so a reference created
 *   mid-run is still seen.
 * - Assets younger than GRACE_MS are never touched: an upload is referenced
 *   only once the client finishes saving the project or profile.
 * - Deletion is opt-in (MEDIA_SWEEP_DELETE=true). Otherwise the job only logs
 *   what it would delete.
 * - If more than MAX_DELETE_FRACTION of the listed assets look orphaned, the
 *   run deletes nothing: that pattern is a broken reference scan, not real
 *   orphans.
 */
import { v2 as cloudinary } from 'cloudinary';
import type { Collection } from 'mongoose';
import User from '../db/user.model.js';
import Playlist from '../db/playlist.model.js';
import Activity from '../db/activity.model.js';
import Notification from '../modules/notifications/notification.model.js';
import Project from '../modules/projects/project.model.js';
import Upload from '../modules/uploads/upload.model.js';
import { isStorageConfigured } from '../modules/uploads/uploads.service.js';

type ResourceType = 'image' | 'video';

export type StoredAsset = { publicId: string; createdAt: Date };

export type MediaStore = {
  list(prefix: string, resourceType: ResourceType): AsyncIterable<StoredAsset>;
  destroy(publicIds: string[], resourceType: ResourceType): Promise<void>;
};

export type SweepResult = {
  listed: number;
  orphaned: number;
  deleted: number;
  /** Set when the run deliberately deleted nothing. */
  skipped?: 'dry_run' | 'too_many_orphans';
};

const ROOT = 'lyrics-syncer/';
const FOLDERS: Array<{ prefix: string; resourceType: ResourceType }> = [
  { prefix: `${ROOT}audio/`, resourceType: 'video' },
  { prefix: `${ROOT}covers/`, resourceType: 'image' },
  { prefix: `${ROOT}profile-covers/`, resourceType: 'image' },
  { prefix: `${ROOT}avatars/`, resourceType: 'image' },
];

const GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_DELETE_FRACTION = 0.5;
const DESTROY_BATCH = 100; // Cloudinary's per-call limit for delete_resources

// Every field that can hold one of our asset URLs or public ids. A field
// missing here makes its assets look orphaned, so add new ones.
const REFERENCES: Array<{ model: { collection: Collection }; fields: string[] }> = [
  { model: Project, fields: ['coverImage'] },
  { model: Playlist, fields: ['coverImage'] },
  { model: Upload, fields: ['publicId', 'uploadUrl', 'coverImage'] },
  { model: User, fields: ['avatarUrl', 'avatarPublicId', 'coverImageUrl', 'coverImagePublicId'] },
  { model: Activity, fields: ['coverImage'] },
  { model: Notification, fields: ['avatarUrl'] },
];

/**
 * `https://res.cloudinary.com/<cloud>/image/upload/<transforms>/v123/lyrics-syncer/covers/u/abc.webp`
 * and a bare `lyrics-syncer/covers/u/abc` both give `lyrics-syncer/covers/u/abc`.
 */
export function assetIdFromReference(value: string): string | null {
  const start = value.indexOf(ROOT);
  if (start === -1) return null;
  const path = value.slice(start).split(/[?#]/)[0];
  const lastSlash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  return dot > lastSlash ? path.slice(0, dot) : path;
}

async function collectReferencedIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  const pattern = /lyrics-syncer\//;
  for (const { model, fields } of REFERENCES) {
    const filter = { $or: fields.map((f) => ({ [f]: pattern })) };
    const projection = Object.fromEntries(fields.map((f) => [f, 1]));
    for await (const doc of model.collection.find(filter, { projection })) {
      for (const field of fields) {
        const value = doc[field];
        if (typeof value !== 'string') continue;
        const id = assetIdFromReference(value);
        if (id) ids.add(id);
      }
    }
  }
  return ids;
}

export async function sweepOrphanedMedia(
  store: MediaStore,
  { now = new Date(), deleteEnabled = false }: { now?: Date; deleteEnabled?: boolean } = {},
): Promise<SweepResult> {
  const cutoff = now.getTime() - GRACE_MS;
  const candidates: Array<{ publicId: string; resourceType: ResourceType }> = [];
  let listed = 0;

  for (const { prefix, resourceType } of FOLDERS) {
    for await (const asset of store.list(prefix, resourceType)) {
      listed++;
      if (asset.createdAt.getTime() < cutoff) candidates.push({ publicId: asset.publicId, resourceType });
    }
  }

  const referenced = await collectReferencedIds();
  const orphans = candidates.filter((c) => !referenced.has(c.publicId));
  const result: SweepResult = { listed, orphaned: orphans.length, deleted: 0 };

  if (orphans.length === 0) return result;
  if (orphans.length > listed * MAX_DELETE_FRACTION) return { ...result, skipped: 'too_many_orphans' };
  if (!deleteEnabled) return { ...result, skipped: 'dry_run' };

  for (const resourceType of ['image', 'video'] as const) {
    const ids = orphans.filter((o) => o.resourceType === resourceType).map((o) => o.publicId);
    for (let i = 0; i < ids.length; i += DESTROY_BATCH) {
      const batch = ids.slice(i, i + DESTROY_BATCH);
      await store.destroy(batch, resourceType);
      result.deleted += batch.length;
    }
  }
  return result;
}

type AdminResourcesPage = {
  resources: Array<{ public_id: string; created_at: string }>;
  next_cursor?: string;
};

export const cloudinaryMediaStore: MediaStore = {
  async *list(prefix, resourceType) {
    let nextCursor: string | undefined;
    do {
      const page = await cloudinary.api.resources({
        type: 'upload',
        resource_type: resourceType,
        prefix,
        max_results: 500,
        next_cursor: nextCursor,
      }) as AdminResourcesPage;
      for (const r of page.resources) yield { publicId: r.public_id, createdAt: new Date(r.created_at) };
      nextCursor = page.next_cursor;
    } while (nextCursor);
  },
  async destroy(publicIds, resourceType) {
    await cloudinary.api.delete_resources(publicIds, { resource_type: resourceType, type: 'upload', invalidate: true });
  },
};

/** Scheduled entry point. */
export async function runMediaSweep(): Promise<SweepResult | null> {
  if (!isStorageConfigured()) return null;
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
  return sweepOrphanedMedia(cloudinaryMediaStore, { deleteEnabled: process.env.MEDIA_SWEEP_DELETE === 'true' });
}
