import { assistModel, chatJson } from './groq-chat.client.js';

export type SingerLabel = { lineIndex: number; singers: string[] };

const SCHEMA = {
  name: 'singers',
  schema: {
    type: 'object',
    properties: {
      labels: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            lineIndex: { type: 'integer' },
            singers: { type: 'array', items: { type: 'string' } },
          },
          required: ['lineIndex', 'singers'],
          additionalProperties: false,
        },
      },
    },
    required: ['labels'],
    additionalProperties: false,
  },
};

type SingersOut = { labels: SingerLabel[] };

function isSingersOut(v: unknown): v is SingersOut {
  if (!v || typeof v !== 'object') return false;
  const r = v as SingersOut;
  return (
    Array.isArray(r.labels) &&
    r.labels.every(
      (l) =>
        !!l && typeof l === 'object' && typeof l.lineIndex === 'number' &&
        Array.isArray(l.singers) && l.singers.every((s) => typeof s === 'string'),
    )
  );
}

const SYSTEM =
  'You assign song lyric lines to singers. Assign each line to one or more names from the roster, ' +
  'using cues in the text: name prefixes, call-and-response, parenthetical echoes. ' +
  'Omit lines with no evidence. Use only names exactly as written in the roster. ' +
  'lineIndex is the zero-based index of the line in the input.';

export async function labelSingers(input: { lines: string[]; roster: string[] }): Promise<SingerLabel[]> {
  const raw = await chatJson<SingersOut>(
    assistModel(),
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: JSON.stringify({ roster: input.roster, lines: input.lines }) },
    ],
    SCHEMA,
    { validate: isSingersOut },
  );

  const roster = new Set(input.roster);
  const seenIndex = new Set<number>();
  const out: SingerLabel[] = [];
  for (const l of raw.labels) {
    if (!Number.isInteger(l.lineIndex) || l.lineIndex < 0 || l.lineIndex >= input.lines.length) continue;
    if (seenIndex.has(l.lineIndex)) continue;
    const singers = [...new Set(l.singers.filter((s) => roster.has(s)))];
    if (singers.length === 0) continue;
    seenIndex.add(l.lineIndex);
    out.push({ lineIndex: l.lineIndex, singers });
  }
  return out;
}
