import { describe, it, expect } from 'vitest';
import { TRENDING, decay, engagementScore, baseScore, computeProjectScores, type EngagementEvent, type ScoreInput } from './trending.score.js';

const NOW = new Date('2026-11-12T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);
const daysAgo = (d: number) => hoursAgo(d * 24);

const star = (over: Partial<EngagementEvent> = {}): EngagementEvent => ({
  kind: 'star', at: NOW, actorCreatedAt: daysAgo(100), actorActions24h: 1, ...over,
});

const project = (publicId: string, over: Partial<ScoreInput> = {}): ScoreInput => ({
  publicId, ownerId: `owner-${publicId}`, createdAt: daysAgo(60), hasMetadata: false, viewCount: 0, events: [], ...over,
});

describe('decay', () => {
  it('halves each half-life and clamps future timestamps', () => {
    const hl = TRENDING.HALF_LIFE_HOURS * 3600_000;
    expect(decay(0, hl)).toBe(1);
    expect(decay(hl, hl)).toBeCloseTo(0.5);
    expect(decay(2 * hl, hl)).toBeCloseTo(0.25);
    expect(decay(-5000, hl)).toBe(1);
  });
});

describe('engagementScore', () => {
  it('weights forks above stars and recent above old', () => {
    expect(engagementScore([star({ kind: 'fork' })], NOW)).toBeGreaterThan(engagementScore([star()], NOW));
    expect(engagementScore([star({ at: hoursAgo(1) })], NOW)).toBeGreaterThan(engagementScore([star({ at: hoursAgo(200) })], NOW));
  });

  it('discounts brand-new and deleted accounts', () => {
    const veteran = engagementScore([star()], NOW);
    expect(engagementScore([star({ actorCreatedAt: daysAgo(1) })], NOW)).toBeCloseTo(veteran * TRENDING.NEW_ACCOUNT_FACTOR);
    expect(engagementScore([star({ actorCreatedAt: null })], NOW)).toBeCloseTo(veteran * TRENDING.NEW_ACCOUNT_FACTOR);
  });

  it('scales down an actor who mass-stars, and leaves normal use alone', () => {
    const normal = engagementScore([star({ actorActions24h: TRENDING.MAX_ACTOR_ACTIONS_24H })], NOW);
    const spammer = engagementScore([star({ actorActions24h: TRENDING.MAX_ACTOR_ACTIONS_24H * 4 })], NOW);
    expect(spammer).toBeCloseTo(normal / 4);
  });
});

describe('baseScore', () => {
  it('ranks newer, described, viewed projects higher and never goes negative', () => {
    const plain = { createdAt: daysAgo(30), hasMetadata: false, viewCount: 0 };
    expect(baseScore({ ...plain, createdAt: daysAgo(1) }, NOW)).toBeGreaterThan(baseScore(plain, NOW));
    expect(baseScore({ ...plain, hasMetadata: true }, NOW)).toBeGreaterThan(baseScore(plain, NOW));
    expect(baseScore({ ...plain, viewCount: 100 }, NOW)).toBeGreaterThan(baseScore(plain, NOW));
    expect(baseScore({ ...plain, viewCount: -5 }, NOW)).toBeGreaterThanOrEqual(0);
  });

  it('caps the view bonus so a viral count cannot drown engagement', () => {
    const p = { createdAt: daysAgo(400), hasMetadata: false };
    expect(baseScore({ ...p, viewCount: 1e9 }, NOW) - baseScore({ ...p, viewCount: 0 }, NOW)).toBeLessThanOrEqual(TRENDING.BASE_VIEWS_MAX);
  });
});

describe('computeProjectScores', () => {
  it('gives idle projects a non-zero, recency-ordered score (no all-zero tie)', () => {
    const s = computeProjectScores([project('old', { createdAt: daysAgo(90) }), project('new', { createdAt: daysAgo(1) })], NOW);
    expect(s.get('old')).toBeGreaterThan(0);
    expect(s.get('new')!).toBeGreaterThan(s.get('old')!);
  });

  it("decays an owner's lesser projects so one user cannot take the whole page", () => {
    const mk = (id: string) => project(id, { ownerId: 'same', events: [star(), star()] });
    const s = computeProjectScores([mk('a'), mk('b'), mk('c'), project('other', { ownerId: 'someone', events: [star(), star()] })], NOW);
    const ranked = ['a', 'b', 'c'].map((id) => s.get(id)!).sort((x, y) => y - x);
    expect(ranked[1]).toBeCloseTo(ranked[0] * TRENDING.OWNER_DECAY, 3);
    expect(ranked[2]).toBeCloseTo(ranked[0] * TRENDING.OWNER_DECAY ** 2, 3);
    expect(s.get('other')!).toBeCloseTo(ranked[0], 3);
  });

  it('does not decay ownerless projects against each other', () => {
    const s = computeProjectScores([project('x', { ownerId: null }), project('y', { ownerId: null })], NOW);
    expect(s.get('x')).toBe(s.get('y'));
  });
});
