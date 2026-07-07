import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'node:child_process';
import { extractVideoId, extractYoutubeAudio } from './ytdlp.client.js';
import { AsrError } from './groq.client.js';

type FakeChild = EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}

/** Queue children returned by successive spawn() calls. */
function queueChildren(...children: FakeChild[]): void {
  const mock = vi.mocked(spawn);
  for (const c of children) mock.mockReturnValueOnce(c as never);
}

function probeJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    duration: 240,
    live_status: 'not_live',
    formats: [
      { format_id: '140', ext: 'm4a', acodec: 'mp4a.40.2', vcodec: 'none', abr: 129 },
      { format_id: '251', ext: 'webm', acodec: 'opus', vcodec: 'none', abr: 160 },
      { format_id: '18', ext: 'mp4', acodec: 'mp4a', vcodec: 'avc1', abr: 96 },
    ],
    ...overrides,
  });
}

function finish(child: FakeChild, stdout: string | Buffer, code = 0, stderr = ''): void {
  setImmediate(() => {
    if (stderr) child.stderr.write(stderr);
    child.stdout.write(stdout);
    child.stdout.end();
    child.stderr.end();
    child.emit('close', code);
  });
}

const abort = () => new AbortController();

describe('extractVideoId', () => {
  it('accepts watch URLs, short URLs, shorts, and bare ids', () => {
    expect(extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(extractVideoId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(extractVideoId('https://youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(extractVideoId('dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });
  it('rejects garbage, injection attempts, and wrong hosts', () => {
    expect(extractVideoId('')).toBeNull();
    expect(extractVideoId('https://evil.com/watch?v=dQw4w9WgXcQ"; rm -rf /')).toBeNull();
    expect(extractVideoId('--exec=calc')).toBeNull();
    expect(extractVideoId('https://youtube.com/watch?v=short')).toBeNull();
  });
});

describe('extractYoutubeAudio', () => {
  beforeEach(() => vi.mocked(spawn).mockReset());

  it('probes then downloads the m4a format, returns buffer + format', async () => {
    const probe = fakeChild();
    const dl = fakeChild();
    queueChildren(probe, dl);
    finish(probe, probeJson());
    const promise = extractYoutubeAudio('dQw4w9WgXcQ', abort().signal);
    // Let the probe resolve, then complete the download.
    await new Promise((r) => setTimeout(r, 10));
    finish(dl, Buffer.from('audio-bytes'));
    const res = await promise;
    expect(res.format).toBe('m4a');
    expect(res.data.equals(Buffer.from('audio-bytes'))).toBe(true);
    // Download call must use the probed format id and canonical URL, array args, no shell.
    const dlArgs = vi.mocked(spawn).mock.calls[1];
    expect(dlArgs[1]).toEqual(['-f', '140', '--no-playlist', '-o', '-', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ']);
    expect(dlArgs[2]).toMatchObject({ shell: false });
  });

  it('falls back to webm when no m4a audio-only format exists', async () => {
    const probe = fakeChild();
    const dl = fakeChild();
    queueChildren(probe, dl);
    finish(probe, probeJson({
      formats: [{ format_id: '251', ext: 'webm', acodec: 'opus', vcodec: 'none', abr: 160 }],
    }));
    const promise = extractYoutubeAudio('dQw4w9WgXcQ', abort().signal);
    await new Promise((r) => setTimeout(r, 10));
    finish(dl, Buffer.from('x'));
    await expect(promise).resolves.toMatchObject({ format: 'webm' });
  });

  it('rejects videos over 20 minutes with asr_youtube_too_long', async () => {
    const probe = fakeChild();
    queueChildren(probe);
    finish(probe, probeJson({ duration: 1201 }));
    await expect(extractYoutubeAudio('dQw4w9WgXcQ', abort().signal))
      .rejects.toMatchObject({ code: 'asr_youtube_too_long' });
  });

  it('rejects live streams with asr_youtube_unavailable', async () => {
    const probe = fakeChild();
    queueChildren(probe);
    finish(probe, probeJson({ live_status: 'is_live' }));
    await expect(extractYoutubeAudio('dQw4w9WgXcQ', abort().signal))
      .rejects.toMatchObject({ code: 'asr_youtube_unavailable' });
  });

  it('maps bot-check stderr to asr_youtube_blocked', async () => {
    const probe = fakeChild();
    queueChildren(probe);
    finish(probe, '', 1, 'ERROR: Sign in to confirm you\'re not a bot');
    await expect(extractYoutubeAudio('dQw4w9WgXcQ', abort().signal))
      .rejects.toMatchObject({ code: 'asr_youtube_blocked' });
  });

  it('maps unavailable stderr to asr_youtube_unavailable', async () => {
    const probe = fakeChild();
    queueChildren(probe);
    finish(probe, '', 1, 'ERROR: Video unavailable');
    await expect(extractYoutubeAudio('dQw4w9WgXcQ', abort().signal))
      .rejects.toMatchObject({ code: 'asr_youtube_unavailable' });
  });

  it('kills the process and rejects when the byte cap is exceeded', async () => {
    const probe = fakeChild();
    const dl = fakeChild();
    queueChildren(probe, dl);
    finish(probe, probeJson());
    const promise = extractYoutubeAudio('dQw4w9WgXcQ', abort().signal);
    await new Promise((r) => setTimeout(r, 10));
    dl.stdout.write(Buffer.alloc(26 * 1024 * 1024)); // > 25 MB
    await expect(promise).rejects.toMatchObject({ code: 'asr_unsupported_audio' });
    expect(dl.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('kills the process and rejects asr_cancelled on abort', async () => {
    const probe = fakeChild();
    queueChildren(probe);
    const ac = abort();
    const promise = extractYoutubeAudio('dQw4w9WgXcQ', ac.signal);
    setImmediate(() => ac.abort());
    await expect(promise).rejects.toMatchObject({ code: 'asr_cancelled' });
    expect(probe.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('handles an already-aborted signal without crashing on a late child error', async () => {
    const probe = fakeChild();
    queueChildren(probe);
    const ac = abort();
    ac.abort(); // aborted BEFORE the call — exercises the early-exit kill path
    const promise = extractYoutubeAudio('dQw4w9WgXcQ', ac.signal);
    await expect(promise).rejects.toMatchObject({ code: 'asr_cancelled' });
    expect(probe.kill).toHaveBeenCalledWith('SIGKILL');
    // A child killed before spawn settles can still emit 'error'. With no
    // 'error' listener registered, EventEmitter throws synchronously from
    // emit — which in production crashes the whole server process.
    expect(() => {
      probe.emit('error', Object.assign(new Error('spawn yt-dlp ENOENT'), { code: 'ENOENT' }));
    }).not.toThrow();
  });

  it('maps ENOENT (binary missing) to asr_ytdlp_not_configured', async () => {
    const probe = fakeChild();
    queueChildren(probe);
    setImmediate(() => probe.emit('error', Object.assign(new Error('spawn yt-dlp ENOENT'), { code: 'ENOENT' })));
    await expect(extractYoutubeAudio('dQw4w9WgXcQ', abort().signal))
      .rejects.toMatchObject({ code: 'asr_ytdlp_not_configured' });
  });

  it('rejects the 4th concurrent extraction with asr_rate_limited', async () => {
    const children = [fakeChild(), fakeChild(), fakeChild()];
    queueChildren(...children);
    const p1 = extractYoutubeAudio('dQw4w9WgXcQ', abort().signal);
    const p2 = extractYoutubeAudio('dQw4w9WgXcQ', abort().signal);
    const p3 = extractYoutubeAudio('dQw4w9WgXcQ', abort().signal);
    await expect(extractYoutubeAudio('dQw4w9WgXcQ', abort().signal))
      .rejects.toMatchObject({ code: 'asr_rate_limited' });
    // Unblock the three running probes so the suite doesn't leak.
    for (const c of children) finish(c, '', 1, 'ERROR: Video unavailable');
    await Promise.allSettled([p1, p2, p3]);
  });
});
