import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./groq-chat.client.js', async (orig) => ({
  ...(await orig<typeof import('./groq-chat.client.js')>()),
  chatJson: vi.fn(),
}));

import { chatJson, AssistError } from './groq-chat.client.js';
import { romanizeLines } from './romanize.service.js';

const chat = vi.mocked(chatJson);
beforeEach(() => chat.mockReset());

describe('romanizeLines', () => {
  it('returns one line per input', async () => {
    chat.mockResolvedValueOnce({ lines: [' sakura ', '', 'hello'] } as never);
    await expect(romanizeLines({ lines: ['桜', '', 'hello'] })).resolves.toEqual(['sakura', '', 'hello']);
  });

  it('a different line count is assist_upstream', async () => {
    chat.mockResolvedValueOnce({ lines: ['a'] } as never);
    const err = await romanizeLines({ lines: ['a', 'b'] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AssistError);
    expect(err).toMatchObject({ code: 'assist_upstream' });
  });

  it('the language is passed in the prompt when given', async () => {
    chat.mockResolvedValueOnce({ lines: ['x'] } as never);
    await romanizeLines({ lines: ['y'], language: 'ja' });
    const msgs = chat.mock.calls[0][1];
    expect(msgs.map((m) => m.content).join('\n')).toContain('ja');
  });

  it('cuts each output to 500', async () => {
    chat.mockResolvedValueOnce({ lines: ['a'.repeat(600)] } as never);
    const [out] = await romanizeLines({ lines: ['y'] });
    expect(out).toHaveLength(500);
  });
});
