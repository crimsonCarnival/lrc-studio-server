import mongoose from 'mongoose';
import Artist from '../artists/artist.model.js';
import { levenshtein } from '../asr/align.service.js';
import { searchLrclib } from '../genius/lrclib.service.js';
import { searchSong } from '../genius/genius.client.js';

export type NameField = 'artist' | 'album';
export type NameCheckInput = { title: string; artist?: string; album?: string };

const MAX_CANDIDATES = 10;
const MAX_DISTANCE = 3;
const MIN_PREFIX_LEN = 3;
const PROVIDER_TOP = 3;

/** Spaces and case only; symbols such as `$` are kept because they are part of names. */
export function matchKey(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/\s+/g, '');
}

/** Seam for approved catalog entries. Fill it once catalog step 1 is deployed. */
export async function catalogCandidates(_field: NameField, _value: string): Promise<string[]> {
  return [];
}

async function ownArtists(userId: string, typed: string): Promise<string[]> {
  if (!mongoose.isValidObjectId(userId)) return [];
  const key = matchKey(typed);
  const rows = await Artist.find({ userId }).select('name').limit(2000).lean();
  return rows
    .map((r) => r.name)
    .filter((name) => {
      const k = matchKey(name);
      return levenshtein(k, key) <= MAX_DISTANCE || (key.length >= MIN_PREFIX_LEN && k.startsWith(key));
    });
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

export async function gatherCandidates(userId: string, field: NameField, input: NameCheckInput): Promise<string[]> {
  const typed = (field === 'artist' ? input.artist : input.album) ?? '';
  const [own, provider, catalog] = await Promise.all([
    field === 'artist' ? ownArtists(userId, typed) : Promise.resolve([]),
    providerCandidates(field, input),
    catalogCandidates(field, typed),
  ]);
  return [...new Set([...own, ...provider, ...catalog])].slice(0, MAX_CANDIDATES);
}
