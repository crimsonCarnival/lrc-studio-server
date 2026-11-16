import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./groq-chat.client.js', async (orig) => ({
  ...(await orig<typeof import('./groq-chat.client.js')>()),
  chatJson: vi.fn(),
}));

import { chatJson } from './groq-chat.client.js';
import { describeSong } from './describe.service.js';
import { PRIMARY_GENRES } from '../../types/index.js';

const chat = vi.mocked(chatJson);
beforeEach(() => chat.mockReset());
const answer = (a: Record<string, unknown>) =>
  chat.mockResolvedValueOnce({ language: null, genre: null, tags: [], ...a } as never);

describe('describeSong', () => {
  it('sends only the first 40 non-empty lines, each ≤ 200 chars', async () => {
    answer({});
    const lines = ['', ...Array.from({ length: 60 }, (_, i) => (i === 0 ? 'a'.repeat(300) : `line ${i}`)), '  '];
    await describeSong({ lines });
    const user = chat.mock.calls[0][1].find((m) => m.role === 'user')!.content;
    const sent = (JSON.parse(user) as { lines: string[] }).lines;
    expect(sent).toHaveLength(40);
    expect(sent[0]).toHaveLength(200);
    expect(sent.every((l) => l.length > 0 && l.length <= 200)).toBe(true);
  });

  it('genre outside PRIMARY_GENRES becomes null', async () => {
    answer({ genre: 'rock' });
    expect((await describeSong({ lines: ['x'] })).genre).toBe('rock');
    answer({ genre: 'vaporwave' });
    expect((await describeSong({ lines: ['x'] })).genre).toBeNull();
  });

  it('invalid language becomes null, "ja" and "pt-BR" pass', async () => {
    for (const [lang, expected] of [['ja', 'ja'], ['pt-BR', 'pt-BR'], ['Spanish', null], ['', null], ['EN', null]] as const) {
      answer({ language: lang });
      expect((await describeSong({ lines: ['x'] })).language).toBe(expected);
    }
  });

  it('tags: lower-cased, de-duplicated, max 5, empty dropped', async () => {
    answer({ tags: ['Love', 'love ', '', 'Rock', 'a', 'b', 'c', 'd', 'x'.repeat(41)] });
    expect((await describeSong({ lines: ['x'] })).tags).toEqual(['love', 'rock', 'a', 'b', 'c']);
  });

  it('the schema enum equals PRIMARY_GENRES plus null', async () => {
    answer({});
    await describeSong({ lines: ['x'] });
    const schema = chat.mock.calls[0][2].schema as { properties: { genre: { enum: unknown[] } } };
    expect(schema.properties.genre.enum).toEqual([...PRIMARY_GENRES, null]);
  });
});
