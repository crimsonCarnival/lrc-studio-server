import { AssistError, assistModel, chatJson } from './groq-chat.client.js';

export type TitleSplit = { songName: string; artists: string[]; album: string | null };

const MAX_ARTISTS = 10;

const SCHEMA = {
  name: 'title_split',
  schema: {
    type: 'object',
    properties: {
      songName: { type: 'string' },
      artists: { type: 'array', items: { type: 'string' } },
      album: { type: ['string', 'null'] },
    },
    required: ['songName', 'artists', 'album'],
    additionalProperties: false,
  },
};

const SYSTEM =
  'You split a video or upload title into the song name, the credited artists and the album. ' +
  'Drop channel and release noise such as "Official", "Audio Oficial", "[videoId]", "HD", "Lyrics". ' +
  'Use album null when the title does not name one. Never invent artists or albums.';

function isTitleSplit(v: unknown): v is TitleSplit {
  if (!v || typeof v !== 'object') return false;
  const r = v as TitleSplit;
  return (
    typeof r.songName === 'string' &&
    Array.isArray(r.artists) && r.artists.every((a) => typeof a === 'string') &&
    (r.album === null || typeof r.album === 'string')
  );
}

export async function splitTitle(title: string): Promise<TitleSplit> {
  const raw = await chatJson<TitleSplit>(
    assistModel(),
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: JSON.stringify({ title }) },
    ],
    SCHEMA,
    { validate: isTitleSplit },
  );

  const songName = raw.songName.trim();
  if (songName.length < 1 || songName.length > 500) throw new AssistError('assist_upstream');

  const seen = new Set<string>();
  const artists: string[] = [];
  for (const a of raw.artists) {
    const name = a.trim();
    const key = name.toLowerCase();
    if (!name || name.length > 300 || seen.has(key)) continue;
    seen.add(key);
    artists.push(name);
    if (artists.length === MAX_ARTISTS) break;
  }

  const album = raw.album?.trim() || null;
  if (album && album.length > 500) throw new AssistError('assist_upstream');

  return { songName, artists, album };
}
