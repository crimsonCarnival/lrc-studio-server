import mongoose from 'mongoose';
import Project from '../projects/project.model.js';
import CatalogArtist from './catalog-artist.model.js';
import CatalogAlbum, { type ICatalogAlbum } from './catalog-album.model.js';
import CatalogAlbumDismissal from './catalog-album-dismissal.model.js';
import { assertManager, adminCreateCatalogAlbum } from './catalog.admin.service.js';
import { fail, invalid, notFound, validId, oid, cleanCatalogText, albumKey, type CatalogError } from './catalog.service.js';
import { artistKey } from '../artists/artist.service.js';
import { logAdminAction } from '../admin/admin.service.js';

const MAX_FINDINGS = 100;
const MAX_KEY = 500;

/** Aggregate only: never project ids, titles, owners or any per-project data. */
export type DetectedAlbum = { key: string; title: string; songCount: number; year: string | null };

type Row = { album: string; year: string | null; primaries: string[] };

async function approvedArtist(artistId: string): Promise<{ _id: mongoose.Types.ObjectId; name: string; nameKey: string; approved: boolean } | null> {
  if (!validId(artistId)) return null;
  const a = await CatalogArtist.findById(oid(artistId)).select('name nameKey status').lean();
  return a ? { _id: a._id, name: a.name, nameKey: a.nameKey, approved: a.status === 'approved' } : null;
}

// Most frequent value; ties go to the smallest by `cmp`.
function mostFrequent(counts: Map<string, number>, cmp: (a: string, b: string) => number): string | null {
  let best: string | null = null;
  let bestN = 0;
  for (const [v, n] of counts) {
    if (n > bestN || (n === bestN && best !== null && cmp(v, best) < 0)) { best = v; bestN = n; }
  }
  return best;
}
const bump = (m: Map<string, number>, k: string, n: number): void => { m.set(k, (m.get(k) ?? 0) + n); };

export async function detectAlbums(adminId: string, artistId: string): Promise<DetectedAlbum[] | CatalogError> {
  const denied = await assertManager(adminId);
  if (denied) return denied;
  const artist = await approvedArtist(artistId);
  if (!artist || !artist.approved) return notFound();

  // $toLower is ASCII-only, so the name filter relies on a case-insensitive collation and
  // JS re-checks artistKey exactly below. The collation only MATCHES: grouping is done in JS,
  // because a collated $group would merge case variants and make "most frequent spelling"
  // arbitrary. The projection keeps whole projects out of memory.
  // This is a collection scan (no index on metadata.artists / songAlbum): acceptable for an
  // on-demand admin tool.
  const rows = await Project.aggregate<Row>([
    { $match: {
      kind: { $ne: 'subtitles' },
      'metadata.songAlbum': { $nin: ['', null] },
      'metadata.artists': { $elemMatch: { role: 'primary', name: artist.name } },
    } },
    { $project: {
      _id: 0,
      album: '$metadata.songAlbum',
      year: '$metadata.songYear',
      primaries: { $map: { input: { $filter: { input: '$metadata.artists', cond: { $eq: ['$$this.role', 'primary'] } } }, in: '$$this.name' } },
    } },
  ]).collation({ locale: 'en', strength: 2, normalization: true });

  type Bucket = { titles: Map<string, number>; years: Map<string, number>; songCount: number };
  const buckets = new Map<string, Bucket>();
  for (const g of rows) {
    if (!Array.isArray(g.primaries) || !g.primaries.some((p) => typeof p === 'string' && artistKey(p) === artist.nameKey)) continue;
    const title = cleanCatalogText(String(g.album));
    const key = albumKey(title);
    if (!key) continue;
    const b = buckets.get(key) ?? { titles: new Map(), years: new Map(), songCount: 0 };
    buckets.set(key, b);
    b.songCount += 1;
    bump(b.titles, title, 1);
    if (typeof g.year === 'string' && /^\d{4}$/.test(g.year)) bump(b.years, g.year, 1);
  }

  const [catalog, dismissed] = await Promise.all([
    CatalogAlbum.find({ artistId: artist._id }).select('titleKey').lean(),
    CatalogAlbumDismissal.find({ artistId: artist._id }).select('titleKey').lean(),
  ]);
  const hidden = new Set([...catalog.map((c) => c.titleKey), ...dismissed.map((d) => d.titleKey)]);

  const out: DetectedAlbum[] = [];
  for (const [key, b] of buckets) {
    if (hidden.has(key)) continue;
    out.push({
      key,
      title: mostFrequent(b.titles, (a, c) => (a < c ? -1 : a > c ? 1 : 0)) ?? key,
      songCount: b.songCount,
      year: mostFrequent(b.years, (a, c) => (a < c ? -1 : a > c ? 1 : 0)),
    });
  }
  out.sort((a, b) => b.songCount - a.songCount || a.title.localeCompare(b.title));
  return out.slice(0, MAX_FINDINGS);
}

export async function approveDetectedAlbum(
  adminId: string,
  artistId: string,
  title: string,
  year: string | null,
): Promise<{ album: ICatalogAlbum } | CatalogError> {
  return adminCreateCatalogAlbum(adminId, { artistId, title, year });
}

export async function dismissDetectedAlbum(adminId: string, artistId: string, key: string): Promise<{ ok: true } | CatalogError> {
  const denied = await assertManager(adminId);
  if (denied) return denied;
  const artist = await approvedArtist(artistId);
  if (!artist || !artist.approved) return notFound();
  if (typeof key !== 'string' || key.trim() === '' || key.length > MAX_KEY) return invalid('Key is required');

  const titleKey = albumKey(cleanCatalogText(key));
  if (!titleKey || titleKey.length > MAX_KEY) return invalid('Key is required');
  let inserted = false;
  try {
    const res = await CatalogAlbumDismissal.updateOne(
      { artistId: oid(artistId), titleKey },
      { $setOnInsert: { dismissedBy: oid(adminId), createdAt: new Date() } },
      { upsert: true },
    );
    inserted = res.upsertedCount === 1;
  } catch (err) {
    // A concurrent upsert of the same key lost the race on the unique index: already dismissed.
    if ((err as { code?: number })?.code !== 11000) return fail(500, 'CATALOG_INTERNAL', 'Could not dismiss');
  }
  if (inserted) {
    try {
      await logAdminAction({ adminId, action: 'catalog.dismiss_album', targetId: artistId, details: JSON.stringify({ key: titleKey }) });
    } catch (err) {
      console.error('[catalog] admin log failed', err);
    }
  }
  return { ok: true };
}
