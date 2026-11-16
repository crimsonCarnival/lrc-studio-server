import mongoose from 'mongoose';
import Project from '../projects/project.model.js';
import User from '../users/user.model.js';
import CatalogArtist from './catalog-artist.model.js';
import CatalogAlbum from './catalog-album.model.js';
import { CATALOG_LIMITS } from './catalog.limits.js';
import { albumKey, cleanName, isError } from './catalog.service.js';
import { artistKey } from '../artists/artist.service.js';
import { parseArtists } from '../../utils/artists.js';

export type BackfillPhase = 'artists' | 'albums';

export type BackfillOptions = {
  phase: BackfillPhase;
  write: boolean;
  /** A candidate must appear on at least this many projects. */
  minSongs: number;
  /** Max entries created (or planned) per run, highest project count first. */
  limit: number;
  /** Max new entries per submitter per run. */
  perUser: number;
  log?: (msg: string) => void;
};

export const BACKFILL_DEFAULTS = { phase: 'artists', write: false, minSongs: 2, limit: 25, perUser: 1 } as const;

export type RowStatus =
  | 'create'
  | 'skipped_existing'
  | 'below_threshold'
  | 'no_eligible_submitter'
  | 'over_limit'
  | 'per_user_limit'
  | 'no_primary_artist'
  | 'parent_not_approved'
  | 'ambiguous_parent'
  | 'error';

export type BackfillRow = {
  kind: 'artist' | 'album';
  name: string;
  artistName: string | null;
  projectCount: number;
  userCount: number;
  /** Id only: never an email or other PII. */
  chosenSubmitterId: string | null;
  status: RowStatus;
  reason: string;
  /** Set only when --write actually inserted the entry. */
  createdId?: string;
};

export type BackfillReport = {
  phase: BackfillPhase;
  write: boolean;
  summary: Record<RowStatus, number> & { candidates: number; created: number };
  rows: BackfillRow[];
};

type UserTally = { count: number; first: number };
type Candidate = {
  /** Most frequent spelling across projects (ties: earliest project). Set once collection ends. */
  name: string;
  spellings: Map<string, { n: number; first: number }>;
  /** Albums only: the primary artist's display name and key. `null` = no clear primary. */
  artistName: string | null;
  artistKey: string | null;
  key: string;
  projects: number;
  users: Map<string, UserTally>;
};

type ProjectRow = {
  _id: mongoose.Types.ObjectId;
  userId?: mongoose.Types.ObjectId | null;
  createdAt?: Date;
  metadata?: {
    artists?: { name?: string; role?: string; order?: number }[] | null;
    songArtist?: string | null;
    songAlbum?: string | null;
  } | null;
};

const clean = (raw: unknown, max: number): string | null => {
  const v = cleanName(raw, max, 'Name');
  return isError(v) ? null : v;
};
const cleanArtist = (raw: unknown): string | null => clean(raw, CATALOG_LIMITS.maxArtistName);

/** Names credited on one project plus its primary, mirroring syncArtistsFromProjects. */
export function extractProjectArtists(meta: ProjectRow['metadata']): { names: string[]; primary: string | null } {
  const credits = [...(meta?.artists ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  if (credits.length > 0) {
    const names = credits.map((c) => cleanArtist(c.name)).filter((n): n is string => n !== null);
    const first = credits.find((c) => c.role === 'primary');
    return { names, primary: first ? cleanArtist(first.name) : null };
  }
  const text = meta?.songArtist ?? '';
  const parsed = parseArtists(text);
  // Same rule as syncArtistsFromProjects: split only when the parser is sure, else keep whole.
  if (parsed.flags.length === 0 && parsed.credits.length > 0) {
    const names = parsed.credits.map((c) => cleanArtist(c.name)).filter((n): n is string => n !== null);
    const lead = parsed.credits[0];
    return { names, primary: lead.role === 'primary' ? cleanArtist(lead.name) : null };
  }
  const whole = cleanArtist(text);
  return { names: whole ? [whole] : [], primary: null };
}

async function collectCandidates(phase: BackfillPhase): Promise<Candidate[]> {
  const map = new Map<string, Candidate>();
  const cursor = Project.find({
    $or: [{ 'metadata.artists.0': { $exists: true } }, { 'metadata.songArtist': { $nin: ['', null] } }],
    ...(phase === 'albums' ? { 'metadata.songAlbum': { $nin: ['', null] } } : {}),
  })
    .select('userId createdAt metadata.artists metadata.songArtist metadata.songAlbum')
    .lean<ProjectRow[]>()
    .cursor();

  const touch = (key: string, name: string, init: () => Candidate, row: ProjectRow): void => {
    const c = map.get(key) ?? init();
    map.set(key, c);
    c.projects += 1;
    const at = (row.createdAt ?? row._id.getTimestamp()).getTime();
    const sp = c.spellings.get(name);
    if (sp) {
      sp.n += 1;
      sp.first = Math.min(sp.first, at);
    } else c.spellings.set(name, { n: 1, first: at });
    if (!row.userId) return;
    const uid = String(row.userId);
    const t = c.users.get(uid);
    if (t) {
      t.count += 1;
      t.first = Math.min(t.first, at);
    } else c.users.set(uid, { count: 1, first: at });
  };

  for await (const row of cursor) {
    const { names, primary } = extractProjectArtists(row.metadata);
    if (phase === 'artists') {
      // One project counts once per artist even when credited twice.
      const seen = new Set<string>();
      for (const name of names) {
        const key = artistKey(name);
        if (seen.has(key)) continue;
        seen.add(key);
        touch(key, name, () => ({ name, spellings: new Map(), artistName: null, artistKey: null, key, projects: 0, users: new Map() }), row);
      }
      continue;
    }
    const title = row.metadata?.songAlbum ? clean(row.metadata.songAlbum, CATALOG_LIMITS.maxAlbumTitle) : null;
    if (!title) continue;
    const aKey = primary ? artistKey(primary) : null;
    const key = `${aKey ?? ''}\u0000${albumKey(title)}`;
    touch(key, title, () => ({ name: title, spellings: new Map(), artistName: primary, artistKey: aKey, key, projects: 0, users: new Map() }), row);
  }
  for (const c of map.values()) {
    const best = [...c.spellings].sort((a, b) => b[1].n - a[1].n || a[1].first - b[1].first)[0];
    c.name = best[0];
  }
  return [...map.values()];
}

const chunk = <T>(xs: T[], n = 500): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const rank: Record<string, number> = { approved: 0, pending: 1, rejected: 2 };
const bestStatus = (a: string | undefined, b: string): string => (a === undefined || rank[b] < rank[a] ? b : a);

type Planned = { cand: Candidate; row: BackfillRow; parentId?: mongoose.Types.ObjectId };
type ToCreate = Planned & { submitter: string };

/** Reads the DB and decides, per candidate, what would happen. Writes nothing. */
export async function planBackfill(opts: BackfillOptions): Promise<{ rows: BackfillRow[]; toCreate: ToCreate[] }> {
  const candidates = await collectCandidates(opts.phase);
  const isAlbum = opts.phase === 'albums';
  const mkRow = (c: Candidate, status: RowStatus, reason = ''): BackfillRow => ({
    kind: isAlbum ? 'album' : 'artist', name: c.name, artistName: c.artistName, projectCount: c.projects,
    userCount: c.users.size, chosenSubmitterId: null, status, reason,
  });
  const rows: BackfillRow[] = [];
  const live: Planned[] = [];

  // Cheap filters first, so the catalog lookups below only cover candidates that could be created.
  const passing: Candidate[] = [];
  for (const c of candidates) {
    if (isAlbum && !c.artistKey) rows.push(mkRow(c, 'no_primary_artist', 'project has no clear primary artist'));
    else if (c.projects < opts.minSongs) rows.push(mkRow(c, 'below_threshold', `${c.projects} < ${opts.minSongs}`));
    else passing.push(c);
  }

  // Existing catalog entries in ANY status: a rejection is never resubmitted.
  const artistStatus = new Map<string, string>();
  const approvedParents = new Map<string, mongoose.Types.ObjectId[]>();
  const albumStatus = new Map<string, string>();
  const artistKeys = [...new Set(passing.map((c) => (isAlbum ? c.artistKey! : c.key)))];
  for (const keys of chunk(artistKeys)) {
    const found = await CatalogArtist.find({ nameKey: { $in: keys } }).select('nameKey status').lean();
    for (const f of found) {
      artistStatus.set(f.nameKey, bestStatus(artistStatus.get(f.nameKey), f.status));
      if (f.status === 'approved') approvedParents.set(f.nameKey, [...(approvedParents.get(f.nameKey) ?? []), f._id]);
    }
  }
  if (isAlbum) {
    const unique = [...approvedParents.values()].filter((ids) => ids.length === 1).map((ids) => ids[0]);
    for (const ids of chunk(unique)) {
      const found = await CatalogAlbum.find({ artistId: { $in: ids } }).select('artistId titleKey status').lean();
      for (const f of found) {
        const k = `${String(f.artistId)} ${f.titleKey}`;
        albumStatus.set(k, bestStatus(albumStatus.get(k), f.status));
      }
    }
  }

  for (const c of passing) {
    if (!isAlbum) {
      const s = artistStatus.get(c.key);
      if (s) {
        rows.push(mkRow(c, 'skipped_existing', s));
        continue;
      }
      live.push({ cand: c, row: mkRow(c, 'create') });
      continue;
    }
    const parents = approvedParents.get(c.artistKey!) ?? [];
    if (parents.length === 0) {
      rows.push(mkRow(c, 'parent_not_approved', artistStatus.get(c.artistKey!) ?? 'no catalog artist'));
      continue;
    }
    // Homonyms (same nameKey, told apart only by disambiguation) cannot be resolved from a project's text.
    if (parents.length > 1) {
      rows.push(mkRow(c, 'ambiguous_parent', `approved artists: ${parents.map(String).join(', ')}`));
      continue;
    }
    const parentId = parents[0];
    const s = albumStatus.get(`${String(parentId)} ${albumKey(c.name)}`);
    if (s) {
      rows.push(mkRow(c, 'skipped_existing', s));
      continue;
    }
    live.push({ cand: c, row: mkRow(c, 'create'), parentId });
  }

  // Submitter eligibility: verified, not deleted, not banned, and room under the pending cap.
  const userIds = [...new Set(live.flatMap((p) => [...p.cand.users.keys()]))];
  const eligible = new Set<string>();
  const pending = new Map<string, number>();
  for (const ids of chunk(userIds)) {
    const oids = ids.map((i) => new mongoose.Types.ObjectId(i));
    const users = await User.find({ _id: { $in: oids }, isVerified: true, isDeleted: { $ne: true }, 'ban.active': { $ne: true } })
      .select('_id')
      .lean();
    users.forEach((u) => eligible.add(String(u._id)));
    const match = { submittedBy: { $in: oids }, status: 'pending' };
    const group = { $group: { _id: '$submittedBy', n: { $sum: 1 } } };
    const aggs = await Promise.all([
      CatalogArtist.aggregate<{ _id: mongoose.Types.ObjectId; n: number }>([{ $match: match }, group]),
      CatalogAlbum.aggregate<{ _id: mongoose.Types.ObjectId; n: number }>([{ $match: match }, group]),
    ]);
    for (const a of aggs.flat()) pending.set(String(a._id), (pending.get(String(a._id)) ?? 0) + a.n);
  }
  // Leave at least one slot of the submitter's own pending cap free.
  const room = CATALOG_LIMITS.maxPending - 1;
  const used = new Map<string, number>();

  // Most projects first; ties by name so the output is stable.
  live.sort((a, b) => b.cand.projects - a.cand.projects || a.cand.name.localeCompare(b.cand.name));
  const toCreate: ToCreate[] = [];
  for (const p of live) {
    const ranked = [...p.cand.users]
      .sort((a, b) => b[1].count - a[1].count || a[1].first - b[1].first)
      .map(([id]) => id);
    const ok = ranked.filter((id) => eligible.has(id) && (pending.get(id) ?? 0) + (used.get(id) ?? 0) < room);
    if (ok.length === 0) {
      // Distinguish "nobody qualifies" from "qualified before, but earlier picks in this run used up their room".
      const exhausted = ranked.some((id) => eligible.has(id) && (pending.get(id) ?? 0) < room);
      rows.push({
        ...p.row, status: 'no_eligible_submitter',
        reason: exhausted ? 'pending room used up by earlier picks in this run' : 'no verified, active user with pending room',
      });
      continue;
    }
    if (toCreate.length >= opts.limit) {
      rows.push({ ...p.row, status: 'over_limit', reason: `limit ${opts.limit}` });
      continue;
    }
    const pick = ok.find((id) => (used.get(id) ?? 0) < opts.perUser);
    if (!pick) {
      rows.push({ ...p.row, status: 'per_user_limit', reason: `per-user ${opts.perUser}`, chosenSubmitterId: ok[0] });
      continue;
    }
    used.set(pick, (used.get(pick) ?? 0) + 1);
    p.row.chosenSubmitterId = pick;
    toCreate.push({ ...p, submitter: pick });
    rows.push(p.row);
  }
  return { rows, toCreate };
}

/**
 * Plans, and with `write` inserts the planned entries as pending community submissions.
 * Uses the models directly (not submitCatalogArtist) so the submitter's caps are not hit,
 * and writes no CatalogSubmissionLog rows so their daily allowance is not consumed.
 */
export async function runBackfill(opts: BackfillOptions): Promise<BackfillReport> {
  const log = opts.log ?? (() => {});
  const { rows, toCreate } = await planBackfill(opts);

  if (opts.write) {
    for (const p of toCreate) {
      const submittedBy = new mongoose.Types.ObjectId(p.submitter);
      const lostRace = (status: string): void => {
        p.row.status = 'skipped_existing';
        p.row.reason = status;
        p.row.chosenSubmitterId = null;
      };
      try {
        if (opts.phase === 'artists') {
          const nameKey = artistKey(p.cand.name);
          // Re-check right before inserting: nothing unique guards nameKey, and a submission may have landed since planning.
          const twin = await CatalogArtist.findOne({ nameKey }).select('status').lean();
          if (twin) { lostRace(twin.status); continue; }
          const doc = await CatalogArtist.create({
            name: p.cand.name, nameKey, bio: '', imageUrl: null, slug: null, status: 'pending', source: 'community', submittedBy,
          });
          p.row.createdId = String(doc._id);
        } else {
          const titleKey = albumKey(p.cand.name);
          // Staff may have rejected or removed the parent since planning.
          if (!(await CatalogArtist.exists({ _id: p.parentId, status: 'approved' }))) {
            p.row.status = 'parent_not_approved';
            p.row.reason = 'parent no longer approved';
            p.row.chosenSubmitterId = null;
            continue;
          }
          const twin = await CatalogAlbum.findOne({ artistId: p.parentId, titleKey }).select('status').lean();
          if (twin) { lostRace(twin.status); continue; }
          const doc = await CatalogAlbum.create({
            artistId: p.parentId, title: p.cand.name, titleKey, year: null, coverUrl: null, slug: null,
            status: 'pending', source: 'community', submittedBy,
          });
          p.row.createdId = String(doc._id);
        }
        log(`created ${p.row.kind} ${p.row.createdId} "${p.row.name}" for ${p.row.chosenSubmitterId}`);
      } catch (err) {
        p.row.status = 'error';
        p.row.reason = err instanceof Error ? err.message : String(err);
      }
    }
  }

  const summary: BackfillReport['summary'] = {
    ambiguous_parent: 0,
    candidates: rows.length, created: rows.filter((r) => r.createdId).length,
    create: 0, skipped_existing: 0, below_threshold: 0, no_eligible_submitter: 0, over_limit: 0,
    per_user_limit: 0, no_primary_artist: 0, parent_not_approved: 0, error: 0,
  };
  for (const r of rows) summary[r.status] += 1;
  return { phase: opts.phase, write: opts.write, summary, rows };
}
