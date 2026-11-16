import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./groq-chat.client.js', async (orig) => ({
  ...(await orig<typeof import('./groq-chat.client.js')>()),
  chatJson: vi.fn(),
}));

import { chatJson, AssistError } from './groq-chat.client.js';
import { splitTitle } from './title-split.service.js';

const chat = vi.mocked(chatJson);
beforeEach(() => chat.mockReset());

describe('splitTitle', () => {
  it('splits the PXNDX example', async () => {
    chat.mockResolvedValueOnce({
      songName: ' Los Malaventurados No Lloran ',
      artists: ['PXNDX', 'pxndx', ''],
      album: '',
    } as never);
    await expect(splitTitle('PXNDX - Los Malaventurados No Lloran [Audio Oficial]')).resolves.toEqual({
      songName: 'Los Malaventurados No Lloran',
      artists: ['PXNDX'],
      album: null,
    });
  });

  it('an empty songName is assist_upstream', async () => {
    chat.mockResolvedValueOnce({ songName: '   ', artists: [], album: null } as never);
    const err = await splitTitle('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AssistError);
    expect(err).toMatchObject({ code: 'assist_upstream' });
  });

  it('artists capped at 10', async () => {
    const artists = Array.from({ length: 15 }, (_, i) => `Artist ${i}`);
    chat.mockResolvedValueOnce({ songName: 's', artists, album: null } as never);
    const r = await splitTitle('x');
    expect(r.artists).toHaveLength(10);
  });
});
