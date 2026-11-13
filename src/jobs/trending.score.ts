// Pure ranking math for Explore, kept free of I/O so it can be unit tested and tuned.
// All weights are starting guesses, not measured values: tune them against the
// explore click-through data (see modules/explore/explore-event.*).

export const TRENDING = {
  /** Engagement loses half its weight every this many hours (replaces the 24h/7d/30d buckets). */
  HALF_LIFE_HOURS: 72,
  STAR_WEIGHT: 3,
  FORK_WEIGHT: 6,
  /** Actors younger than this count for NEW_ACCOUNT_FACTOR: cheap sockpuppets should not rank projects. */
  NEW_ACCOUNT_DAYS: 7,
  NEW_ACCOUNT_FACTOR: 0.25,
  /** One actor's stars+forks beyond this in 24h are scaled down by MAX/actual (mass-starring). */
  MAX_ACTOR_ACTIONS_24H: 10,
  /** Cold-start base so projects with no engagement still order sensibly (newest and most complete first). */
  BASE_RECENCY: 2,
  BASE_HALF_LIFE_DAYS: 14,
  BASE_METADATA: 0.5,
  BASE_VIEWS_MAX: 1,
  /** An owner's k-th best project (0-based) is scaled by OWNER_DECAY^k so one prolific user cannot flood a page. */
  OWNER_DECAY: 0.85,
} as const;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** 1 at age 0, 0.5 after one half-life; future timestamps clamp to age 0. */
export function decay(ageMs: number, halfLifeMs: number): number {
  return Math.pow(2, -Math.max(0, ageMs) / halfLifeMs);
}

export type EngagementEvent = {
  kind: 'star' | 'fork';
  at: Date;
  /** The actor's account creation date; null when the account is gone (counts as new). */
  actorCreatedAt: Date | null;
  /** How many stars+forks this actor made in the last 24h across all projects. */
  actorActions24h: number;
};

export function engagementScore(events: EngagementEvent[], now: Date): number {
  let sum = 0;
  for (const e of events) {
    const base = e.kind === 'fork' ? TRENDING.FORK_WEIGHT : TRENDING.STAR_WEIGHT;
    const isNew = !e.actorCreatedAt || now.getTime() - e.actorCreatedAt.getTime() < TRENDING.NEW_ACCOUNT_DAYS * DAY_MS;
    const accountFactor = isNew ? TRENDING.NEW_ACCOUNT_FACTOR : 1;
    const capFactor = e.actorActions24h > TRENDING.MAX_ACTOR_ACTIONS_24H ? TRENDING.MAX_ACTOR_ACTIONS_24H / e.actorActions24h : 1;
    sum += base * accountFactor * capFactor * decay(now.getTime() - e.at.getTime(), TRENDING.HALF_LIFE_HOURS * HOUR_MS);
  }
  return sum;
}

export type BaseInput = { createdAt: Date; hasMetadata: boolean; viewCount: number };

export function baseScore(p: BaseInput, now: Date): number {
  const recency = TRENDING.BASE_RECENCY * decay(now.getTime() - p.createdAt.getTime(), TRENDING.BASE_HALF_LIFE_DAYS * DAY_MS);
  const metadata = p.hasMetadata ? TRENDING.BASE_METADATA : 0;
  // log10 so the first few views count and a viral count does not drown engagement.
  const views = Math.min(TRENDING.BASE_VIEWS_MAX, Math.log10(1 + Math.max(0, p.viewCount)) / 2);
  return recency + metadata + views;
}

export type ScoreInput = BaseInput & {
  publicId: string;
  ownerId: string | null;
  events: EngagementEvent[];
};

/** Score every project, then apply the per-owner diversity decay. Returns publicId -> score. */
export function computeProjectScores(projects: ScoreInput[], now: Date): Map<string, number> {
  const scored = projects.map((p) => ({
    publicId: p.publicId,
    ownerId: p.ownerId,
    // Covers are not scored: Explore sorts by the hasCover field before this score.
    score: engagementScore(p.events, now) + baseScore(p, now),
  }));

  const byOwner = new Map<string, typeof scored>();
  for (const s of scored) {
    if (!s.ownerId) continue; // anonymous projects have no owner to flood with
    const list = byOwner.get(s.ownerId);
    if (list) list.push(s);
    else byOwner.set(s.ownerId, [s]);
  }
  for (const list of byOwner.values()) {
    list.sort((a, b) => b.score - a.score);
    list.forEach((s, k) => { s.score *= Math.pow(TRENDING.OWNER_DECAY, k); });
  }

  // 4 decimals: enough resolution for ordering, no float noise in the DB.
  return new Map(scored.map((s) => [s.publicId, Math.round(s.score * 1e4) / 1e4]));
}
