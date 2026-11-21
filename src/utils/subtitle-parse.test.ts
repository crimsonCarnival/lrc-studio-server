import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { parseSubtitleCues, subtitleImportFormat } from './subtitle-parse.js';

vi.mock('../modules/settings/settings.model.js', () => ({ default: {} }));
vi.mock('../db/job-log.model.js', () => ({ default: {} }));

describe('subtitleImportFormat', () => {
  it('names the subtitle formats and nothing else', () => {
    expect(subtitleImportFormat('Song.VTT')).toBe('vtt');
    expect(subtitleImportFormat('a.sbv')).toBe('sbv');
    expect(subtitleImportFormat('a.ssa')).toBe('ass');
    expect(subtitleImportFormat('a.ass')).toBe('ass');
    expect(subtitleImportFormat('a.srt')).toBeNull();
    expect(subtitleImportFormat('a.lrc')).toBeNull();
  });
});

describe('WebVTT', () => {
  it('reads cues with ids, settings, short clocks and markup, and skips NOTE/STYLE blocks', () => {
    const vtt = [
      '\uFEFFWEBVTT Kind: captions',
      '',
      'NOTE written by hand',
      '',
      'STYLE',
      '::cue { color: yellow }',
      '',
      'intro',
      '00:00:01.500 --> 00:00:04.000 align:start line:90%',
      '<v Singer>Hello &amp; <i>welcome</i></v>',
      '',
      '00:05.000 --> 00:07.250',
      'second <00:06.000>line',
      'wraps here',
      '',
    ].join('\r\n');
    expect(parseSubtitleCues(vtt, 'vtt')).toEqual([
      { start: 1.5, end: 4, text: 'Hello & welcome' },
      { start: 5, end: 7.25, text: 'second line\nwraps here' },
    ]);
  });
});

describe('SBV', () => {
  it('reads YouTube SBV blocks', () => {
    const sbv = '0:00:01.000,0:00:03.500\nfirst\n\n0:01:02.250,0:01:05.000\nsecond\nline\n';
    expect(parseSubtitleCues(sbv, 'sbv')).toEqual([
      { start: 1, end: 3.5, text: 'first' },
      { start: 62.25, end: 65, text: 'second\nline' },
    ]);
  });
});

describe('ASS / SSA', () => {
  it('reads Dialogue events by the Format line, keeps commas in text, drops overrides and comments, sorts by time', () => {
    const ass = [
      '[Script Info]',
      'Title: x',
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: 0,0:00:05.00,0:00:07.50,Default,,0,0,0,,{\\k20}Later, with a comma',
      'Comment: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,not shown',
      'Dialogue: 0,0:00:01.20,0:00:03.00,Default,,0,0,0,,{\\i1}First\\Nsecond\\hrow',
    ].join('\n');
    expect(parseSubtitleCues(ass, 'ass')).toEqual([
      { start: 1.2, end: 3, text: 'First\nsecond row' },
      { start: 5, end: 7.5, text: 'Later, with a comma' },
    ]);
  });
});

describe('hostile input stays linear (the parse route is public, content up to 1 MiB)', () => {
  const quick = (fn: () => unknown) => {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  };

  it('a long run of unclosed < or { does not backtrack quadratically', () => {
    const lt = `WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n${'<'.repeat(200_000)}\n`;
    const brace = `[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,${'{'.repeat(200_000)}\n`;
    expect(quick(() => parseSubtitleCues(lt, 'vtt'))).toBeLessThan(1000);
    expect(quick(() => parseSubtitleCues(brace, 'ass'))).toBeLessThan(1000);
  });

  it('a Format line with absurdly many fields is ignored, not paid for on every event', () => {
    const format = `Format: ${Array.from({ length: 50_000 }, (_, i) => `f${i}`).join(',')}`;
    const events = Array.from({ length: 5_000 }, () => 'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,hi').join('\n');
    const ass = `[Events]\n${format}\n${events}\n`;
    let cues: unknown[] = [];
    expect(quick(() => { cues = parseSubtitleCues(ass, 'ass'); })).toBeLessThan(1000);
    // The default v4+ layout still applies, so the events are read.
    expect(cues).toHaveLength(5_000);
  });

  it('an event with fewer fields than its Format line is skipped, not misread', () => {
    const ass = '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00\n';
    expect(parseSubtitleCues(ass, 'ass')).toEqual([]);
  });
});

describe('POST /lyrics/parse with a subtitle file', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    const { default: lyricsRoutes } = await import('../modules/lyrics/lyrics.routes.js');
    app = Fastify();
    app.decorate('optionalAuth', async () => {});
    await app.register(lyricsRoutes, { prefix: '/lyrics' });
    await app.ready();
  });
  afterAll(async () => { await app.close(); });

  it('returns timed lines with end times, tagged as imported, in SRT mode', async () => {
    const res = await app.inject({
      method: 'POST', url: '/lyrics/parse',
      payload: { content: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi\n', filename: 'song.vtt' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.detectedFormat).toBe('srt');
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0]).toMatchObject({ text: 'hi', timestamp: 1, endTime: 2, source: 'import' });
  });

  it('still refuses other extensions', async () => {
    const res = await app.inject({ method: 'POST', url: '/lyrics/parse', payload: { content: 'x', filename: 'a.docx' } });
    expect(res.statusCode).toBe(400);
  });
});
