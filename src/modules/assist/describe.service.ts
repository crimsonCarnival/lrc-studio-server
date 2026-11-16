import { PRIMARY_GENRES, type PrimaryGenre } from '../../types/index.js';
import { assistModel, chatJson } from './groq-chat.client.js';

export type Description = { language: string | null; genre: PrimaryGenre | null; tags: string[] };
export type DescribeInput = { title?: string; artist?: string; lines: string[] };

const MAX_LINES = 40;
const MAX_LINE_CHARS = 200;
const MAX_TAGS = 5;
const MAX_TAG_CHARS = 40;
const LANGUAGE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

const SCHEMA = {
  name: 'describe',
  schema: {
    type: 'object',
    properties: {
      language: { type: ['string', 'null'] },
      genre: { type: ['string', 'null'], enum: [...PRIMARY_GENRES, null] },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['language', 'genre', 'tags'],
    additionalProperties: false,
  },
};

const SYSTEM =
  'You describe a song from its title, artist and the opening lyric lines. Answer with the lyrics language ' +
  'as a BCP-47 code (for example "en", "ja", "pt-BR"), one genre from the allowed list, and up to 5 short ' +
  'lower-case descriptive tags (mood, theme). Use null when unsure. Never invent facts.';

function isDescription(v: unknown): v is { language: string | null; genre: string | null; tags: string[] } {
  if (!v || typeof v !== 'object') return false;
  const r = v as { language: unknown; genre: unknown; tags: unknown };
  return (
    (r.language === null || typeof r.language === 'string') &&
    (r.genre === null || typeof r.genre === 'string') &&
    Array.isArray(r.tags) && r.tags.every((t) => typeof t === 'string')
  );
}

export async function describeSong(input: DescribeInput): Promise<Description> {
  const lines = input.lines
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, MAX_LINES)
    .map((l) => l.slice(0, MAX_LINE_CHARS));

  const raw = await chatJson(
    assistModel(),
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: JSON.stringify({ title: input.title, artist: input.artist, lines }) },
    ],
    SCHEMA,
    { validate: isDescription },
  );

  const language = raw.language && LANGUAGE_RE.test(raw.language) ? raw.language : null;
  const genre = PRIMARY_GENRES.find((g) => g === raw.genre) ?? null;

  const tags: string[] = [];
  for (const t of raw.tags) {
    const tag = t.trim().toLowerCase();
    if (tag.length < 1 || tag.length > MAX_TAG_CHARS || tags.includes(tag)) continue;
    tags.push(tag);
    if (tags.length === MAX_TAGS) break;
  }
  return { language, genre, tags };
}
