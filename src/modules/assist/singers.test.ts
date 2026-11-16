import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./groq-chat.client.js', async (orig) => ({
  ...(await orig<typeof import('./groq-chat.client.js')>()),
  chatJson: vi.fn(),
}));

import { chatJson } from './groq-chat.client.js';
import { labelSingers } from './singers.service.js';

const chat = vi.mocked(chatJson);
beforeEach(() => chat.mockReset());

const lines = ['a', 'b', 'c'];
const roster = ['Ana', 'Bob'];

describe('labelSingers', () => {
  it('drops out-of-range and non-integer lineIndex', async () => {
    chat.mockResolvedValueOnce({
      labels: [
        { lineIndex: -1, singers: ['Ana'] },
        { lineIndex: 3, singers: ['Ana'] },
        { lineIndex: 1.5, singers: ['Ana'] },
        { lineIndex: 2, singers: ['Bob'] },
      ],
    } as never);
    await expect(labelSingers({ lines, roster })).resolves.toEqual([{ lineIndex: 2, singers: ['Bob'] }]);
  });

  it('drops names outside the roster', async () => {
    chat.mockResolvedValueOnce({
      labels: [{ lineIndex: 0, singers: ['Ana', 'ana', 'Zed', 'Ana'] }],
    } as never);
    await expect(labelSingers({ lines, roster })).resolves.toEqual([{ lineIndex: 0, singers: ['Ana'] }]);
  });

  it('an entry with no valid names is dropped', async () => {
    chat.mockResolvedValueOnce({ labels: [{ lineIndex: 0, singers: ['ana'] }] } as never);
    await expect(labelSingers({ lines, roster })).resolves.toEqual([]);
  });

  it('duplicate lineIndex keeps the first', async () => {
    chat.mockResolvedValueOnce({
      labels: [
        { lineIndex: 1, singers: ['Ana'] },
        { lineIndex: 1, singers: ['Bob'] },
      ],
    } as never);
    await expect(labelSingers({ lines, roster })).resolves.toEqual([{ lineIndex: 1, singers: ['Ana'] }]);
  });
});
