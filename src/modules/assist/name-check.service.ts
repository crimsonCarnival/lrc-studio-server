import { assistModel, chatJson } from './groq-chat.client.js';
import { gatherCandidates, matchKey, type NameCheckInput, type NameField } from './name-check.candidates.js';

export type { NameCheckInput, NameField } from './name-check.candidates.js';
export type NameSuggestion = { field: NameField; suggestion: string; confidence: number };

const MIN_CONFIDENCE = 0.6;
const FIELDS: NameField[] = ['artist', 'album'];

type ModelAnswer = { matches: Array<{ field: NameField; candidate: string | null; confidence: number }> };

const SCHEMA = {
  name: 'name_check',
  schema: {
    type: 'object',
    properties: {
      matches: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            field: { type: 'string', enum: ['artist', 'album'] },
            candidate: { type: ['string', 'null'] },
            confidence: { type: 'number' },
          },
          required: ['field', 'candidate', 'confidence'],
          additionalProperties: false,
        },
      },
    },
    required: ['matches'],
    additionalProperties: false,
  },
};

const SYSTEM =
  'You check typed music metadata. For each field, the typed value may be a misspelling, truncation or ' +
  'transposition of exactly one of the listed candidates. Answer only with a candidate copied exactly as ' +
  'written, or null when none fits. Never invent a name. Stylised spellings (symbols, unusual casing) are ' +
  'intentional, so do not "correct" them.';

function isModelAnswer(v: unknown): v is ModelAnswer {
  if (!v || typeof v !== 'object' || !Array.isArray((v as ModelAnswer).matches)) return false;
  return (v as ModelAnswer).matches.every(
    (m) =>
      !!m && typeof m === 'object' &&
      (m.field === 'artist' || m.field === 'album') &&
      (m.candidate === null || typeof m.candidate === 'string') &&
      typeof m.confidence === 'number',
  );
}

export async function checkNames(userId: string, input: NameCheckInput): Promise<NameSuggestion[]> {
  const results: NameSuggestion[] = [];
  const pending: Array<{ field: NameField; typed: string; candidates: string[] }> = [];

  for (const field of FIELDS) {
    const typed = input[field]?.trim();
    if (!typed) continue;
    const candidates = await gatherCandidates(userId, field, input);
    if (candidates.length === 0 || candidates.includes(typed)) continue;
    const same = candidates.filter((c) => matchKey(c) === matchKey(typed));
    if (same.length === 1) {
      results.push({ field, suggestion: same[0], confidence: 1 });
      continue;
    }
    pending.push({ field, typed, candidates });
  }

  if (pending.length > 0) {
    const payload = {
      song: input.title,
      fields: pending.map((p) => ({ field: p.field, typed: p.typed, candidates: p.candidates })),
    };
    const answer = await chatJson<ModelAnswer>(
      assistModel(),
      [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: JSON.stringify(payload) },
      ],
      SCHEMA,
      { validate: isModelAnswer },
    );
    for (const p of pending) {
      const m = answer.matches.find((x) => x.field === p.field);
      if (m?.candidate && p.candidates.includes(m.candidate) && m.candidate !== p.typed && m.confidence >= MIN_CONFIDENCE) {
        results.push({ field: p.field, suggestion: m.candidate, confidence: m.confidence });
      }
    }
  }
  return results;
}
