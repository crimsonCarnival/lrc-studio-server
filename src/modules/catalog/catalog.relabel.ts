import CatalogArtist from './catalog-artist.model.js';
import CatalogAlbum from './catalog-album.model.js';
import User from '../users/user.model.js';
import { hasPermission } from '../../shared/permissions.js';
import type { CatalogStatus } from './catalog.types.js';

export type RelabelRow = {
  kind: 'artist' | 'album';
  id: string;
  submittedBy: string;
  status: CatalogStatus;
  creditAwarded: boolean;
};

export type RelabelReport = {
  write: boolean;
  counts: { artist: number; album: number };
  creditAwarded: { artist: number; album: number };
  ids: { artist: string[]; album: string[] };
  modified: number;
};

/** Same rule as the catalog.manage gate: the permission, or superadmin (who holds every permission). */
export function isCatalogStaff(user: { permissions?: string[]; role?: string }): boolean {
  return hasPermission(user.permissions, 'catalog.manage') || user.role === 'superadmin';
}

/** Pure: keeps the rows a staff user submitted. creditAwarded rows are kept and only counted. */
export function planRelabel(rows: RelabelRow[], staffIds: ReadonlySet<string>): Omit<RelabelReport, 'write' | 'modified'> {
  const plan: Omit<RelabelReport, 'write' | 'modified'> = {
    counts: { artist: 0, album: 0 },
    creditAwarded: { artist: 0, album: 0 },
    ids: { artist: [], album: [] },
  };
  for (const r of rows) {
    if (!staffIds.has(r.submittedBy)) continue;
    plan.counts[r.kind]++;
    plan.ids[r.kind].push(r.id);
    if (r.creditAwarded) plan.creditAwarded[r.kind]++;
  }
  return plan;
}

/**
 * Relabels community-sourced catalog entries submitted by staff to source 'admin', in any status.
 * Only `source` is written: creditAwarded, XP and user stats are never touched, and updatedAt is kept.
 */
export async function runRelabel(opts: { write: boolean; log?: (m: string) => void }): Promise<RelabelReport> {
  const log = opts.log ?? (() => undefined);
  const [artists, albums] = await Promise.all([
    CatalogArtist.find({ source: 'community' }).select('_id submittedBy status creditAwarded').lean(),
    CatalogAlbum.find({ source: 'community' }).select('_id submittedBy status creditAwarded').lean(),
  ]);
  const rows: RelabelRow[] = [
    ...artists.map((d) => ({ kind: 'artist' as const, id: String(d._id), submittedBy: String(d.submittedBy), status: d.status, creditAwarded: d.creditAwarded })),
    ...albums.map((d) => ({ kind: 'album' as const, id: String(d._id), submittedBy: String(d.submittedBy), status: d.status, creditAwarded: d.creditAwarded })),
  ];
  const submitterIds = [...new Set(rows.map((r) => r.submittedBy))];
  log(`Community entries: ${artists.length} artists, ${albums.length} albums, ${submitterIds.length} distinct submitters`);
  const users = await User.find({ _id: { $in: submitterIds } }).select('permissions role').lean();
  const staffIds = new Set(users.filter(isCatalogStaff).map((u) => String(u._id)));

  const plan = planRelabel(rows, staffIds);
  let modified = 0;
  if (opts.write) {
    // The source guard keeps a concurrent change from being overwritten and makes reruns no-ops.
    const guard = (ids: string[]) => ({ _id: { $in: ids }, source: 'community' as const });
    const set = { $set: { source: 'admin' as const } };
    if (plan.ids.artist.length) modified += (await CatalogArtist.updateMany(guard(plan.ids.artist), set, { timestamps: false })).modifiedCount;
    if (plan.ids.album.length) modified += (await CatalogAlbum.updateMany(guard(plan.ids.album), set, { timestamps: false })).modifiedCount;
  }
  return { write: opts.write, ...plan, modified };
}
