import mongoose from 'mongoose';
import Artist from '../artists/artist.model.js';
import Project from '../projects/project.model.js';
import CatalogArtist from '../catalog/catalog-artist.model.js';
import CatalogAlbum from '../catalog/catalog-album.model.js';
import { artistKey } from '../artists/artist.service.js';
import { levenshtein } from '../asr/align.service.js';
import { searchLrclib } from '../genius/lrclib.service.js';
import { searchSong } from '../genius/genius.client.js';

export type NameField = 'artist' | 'album';
/** `field`, when set, is the only field checked; the other values are context (e.g. the artist of an album). */
export type NameCheckInput = { title: string; artist?: string; album?: string; field?: NameField };

/**
 * Candidates in priority order. `trusted` names come from the moderated catalog or the user's own
 * records: only those may "correct" a value that differs from them in case or spacing alone, since a
 * provider's casing is crowd-sourced and the user's may be a deliberate stylisation.
 */
export type Candidates = { names: string[]; trusted: Set<string> };

const MAX_CANDIDATES = 10;
const MAX_DISTANCE = 3;
const MIN_PREFIX_LEN = 3;
const PROVIDER_TOP = 3;
const CATALOG_SCAN = 5000;
const OWN_SCAN = 2000;

/** Spaces and case only; symbols such as `$` are kept because they are part of names. */
export function matchKey(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/\s+/g, '');
}

/**
 * Edits allowed between a typed key and a candidate key. Scales with length so short names
 * ("IU", "Ado") are not near every other short name: 1 up to 7 characters, 2 up to 11, then 3.
 */
export function maxDistanceFor(typedKey: string): number {
  return Math.min(MAX_DISTANCE, Math.max(1, Math.floor(typedKey.length / 4)));
}

/** A plausible misspelling (small edit distance) or truncation (prefix) of `candidate`. */
export function isNear(typed: string, candidate: string): boolean {
  const key = matchKey(typed);
  const k = matchKey(candidate);
  if (!key || !k) return false;
  return levenshtein(k, key) <= maxDistanceFor(key) || (key.length >= MIN_PREFIX_LEN && k.startsWith(key));
}

/** The one approved catalog artist with this exact name key; null when none or homonyms. */
async function catalogArtistFor(name: string): Promise<mongoose.Types.ObjectId | null> {
  const key = artistKey(name.trim());
  if (!key) return null;
  const rows = await CatalogArtist.find({ status: 'approved', nameKey: key }).select('_id').limit(2).lean();
  return rows.length === 1 ? rows[0]._id : null;
}

/** Approved catalog names near the typed value. Albums are only looked up under a known catalog artist. */
export async function catalogCandidates(field: NameField, typed: string, input: NameCheckInput): Promise<string[]> {
  if (field === 'artist') {
    const rows = await CatalogArtist.find({ status: 'approved' }).select('name').limit(CATALOG_SCAN).lean();
    return rows.map((r) => r.name).filter((name) => isNear(typed, name));
  }
  const artistId = input.artist ? await catalogArtistFor(input.artist) : null;
  if (!artistId) return [];
  const rows = await CatalogAlbum.find({ artistId, status: 'approved' }).select('title').lean();
  return rows.map((r) => r.title).filter((title) => isNear(typed, title));
}

async function ownArtists(userId: string, typed: string): Promise<string[]> {
  const rows = await Artist.find({ userId }).select('name').limit(OWN_SCAN).lean();
  return rows.map((r) => r.name).filter((name) => isNear(typed, name));
}

/** Album names on the user's own projects, narrowed to the given artist when there is one. */
async function ownAlbums(userId: string, typed: string, artist: string | undefined): Promise<string[]> {
  const filter: Record<string, unknown> = { userId: new mongoose.Types.ObjectId(userId), 'metadata.songAlbum': { $nin: ['', null] } };
  if (artist?.trim()) {
    const exact = new RegExp(`^${artist.trim().normalize('NFC').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    filter['metadata.artists'] = { $elemMatch: { name: exact } };
  }
  const albums = (await Project.distinct('metadata.songAlbum', filter)) as unknown[];
  return albums.filter((a): a is string => typeof a === 'string').slice(0, OWN_SCAN).filter((a) => isNear(typed, a));
}

async function providerCandidates(field: NameField, input: NameCheckInput): Promise<string[]> {
  const query = `${input.title} ${input.artist ?? ''}`.trim();
  const out: string[] = [];
  try {
    for (const h of (await searchLrclib(query)).slice(0, PROVIDER_TOP)) {
      const v = field === 'artist' ? h.artist : h.album;
      if (v) out.push(v);
    }
  } catch { /* a failing provider contributes nothing */ }
  if (field === 'artist') {
    try {
      for (const h of ((await searchSong(query)) ?? []).slice(0, PROVIDER_TOP)) {
        if (h.primary_artist?.name) out.push(h.primary_artist.name);
      }
    } catch { /* a failing provider contributes nothing */ }
  }
  return out;
}

export async function gatherCandidates(userId: string, field: NameField, input: NameCheckInput): Promise<Candidates> {
  const typed = (field === 'artist' ? input.artist : input.album) ?? '';
  const validUser = mongoose.isValidObjectId(userId);
  const [catalog, own, provider] = await Promise.all([
    catalogCandidates(field, typed, input),
    !validUser ? Promise.resolve([]) : field === 'artist' ? ownArtists(userId, typed) : ownAlbums(userId, typed, input.artist),
    providerCandidates(field, input),
  ]);
  // Catalog first: it is the only moderated source, so it must survive the cap.
  const names = [...new Set([...catalog, ...own, ...provider])].slice(0, MAX_CANDIDATES);
  return { names, trusted: new Set([...catalog, ...own]) };
}
