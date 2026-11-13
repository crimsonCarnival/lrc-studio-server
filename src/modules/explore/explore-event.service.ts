import Project from '../projects/project.model.js';
import ExploreEvent from './explore-event.model.js';

export type ExploreEventInput = { publicId: string; type: 'IMPRESSION' | 'CLICK'; position?: number | null };

export const MAX_EVENTS_PER_CALL = 50;
const MAX_POSITION = 10_000;

const utcDay = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/**
 * Fold a batch of client events into per-project daily counters. Anonymous and
 * unauthenticated by design, so it is treated as untrusted: the batch is capped,
 * only ids of real public projects are kept (a forged id cannot create rows), and
 * positions are clamped. The numbers are for tuning, never for ranking directly.
 */
export async function recordExploreEvents(events: ExploreEventInput[], now = new Date()): Promise<void> {
  const batch = events.slice(0, MAX_EVENTS_PER_CALL);
  if (batch.length === 0) return;

  const ids = [...new Set(batch.map((e) => e.publicId))];
  const real = await Project.find({ publicId: { $in: ids }, public: true }).select('publicId').lean<{ publicId: string }[]>();
  const valid = new Set(real.map((p) => p.publicId));

  const tally = new Map<string, { impressions: number; clicks: number; positionSum: number }>();
  for (const e of batch) {
    if (!valid.has(e.publicId)) continue;
    const t = tally.get(e.publicId) ?? { impressions: 0, clicks: 0, positionSum: 0 };
    if (e.type === 'CLICK') t.clicks += 1;
    else {
      t.impressions += 1;
      t.positionSum += Math.min(MAX_POSITION, Math.max(0, Math.floor(e.position ?? 0)));
    }
    tally.set(e.publicId, t);
  }
  if (tally.size === 0) return;

  const day = utcDay(now);
  await ExploreEvent.bulkWrite(
    [...tally].map(([publicId, inc]) => ({
      updateOne: { filter: { publicId, day }, update: { $inc: inc }, upsert: true },
    })),
    { ordered: false },
  );
}
