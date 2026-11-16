import { AssistError, assistModel, chatJson } from './groq-chat.client.js';

const MAX_LINE = 500;

const SCHEMA = {
  name: 'romanize',
  schema: {
    type: 'object',
    properties: { lines: { type: 'array', items: { type: 'string' } } },
    required: ['lines'],
    additionalProperties: false,
  },
};

type RomanizeOut = { lines: string[] };

function isRomanizeOut(v: unknown): v is RomanizeOut {
  if (!v || typeof v !== 'object') return false;
  const r = v as RomanizeOut;
  return Array.isArray(r.lines) && r.lines.every((l) => typeof l === 'string');
}

const SYSTEM =
  'You romanize song lyrics into Latin script. Return exactly one romanized line per input line, ' +
  'in the same order. A line already in Latin script is returned unchanged. An empty input line stays empty. ' +
  'Never merge, split, translate or drop lines.';

export async function romanizeLines(input: { lines: string[]; language?: string }): Promise<string[]> {
  const raw = await chatJson<RomanizeOut>(
    assistModel(),
    [
      {
        role: 'system',
        content: input.language ? `${SYSTEM} The lyrics language is: ${input.language}.` : SYSTEM,
      },
      { role: 'user', content: JSON.stringify({ lines: input.lines }) },
    ],
    SCHEMA,
    { validate: isRomanizeOut },
  );

  if (raw.lines.length !== input.lines.length) throw new AssistError('assist_upstream');
  return raw.lines.map((l) => l.trim().slice(0, MAX_LINE));
}
