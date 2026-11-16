import mongoose from 'mongoose';
import AssistUsage from './assist-usage.model.js';
import { AssistError } from './groq-chat.client.js';

const DEFAULT_CAP = 20;
const DAY_MS = 86_400_000;

export type HeavyUsage = { used: number; cap: number; remaining: number; resetsAt: Date };

export function utcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function heavyCap(): number {
  const n = parseInt(process.env.ASSIST_HEAVY_DAILY_CAP ?? '', 10);
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_CAP;
}

const toUsage = (used: number, cap: number, day: Date): HeavyUsage => ({
  used,
  cap,
  remaining: Math.max(0, cap - used),
  resetsAt: new Date(day.getTime() + DAY_MS),
});

export async function getHeavyUsage(userId: string, now: Date = new Date()): Promise<HeavyUsage> {
  const day = utcDay(now);
  const doc = await AssistUsage.findOne({ userId: new mongoose.Types.ObjectId(userId), day }).lean();
  return toUsage(doc?.heavy ?? 0, heavyCap(), day);
}

/**
 * Reserve one run atomically: the upsert filter carries the `heavy < cap` guard, so
 * at the cap it matches nothing and tries to insert, which collides with the unique
 * {userId, day} index (E11000). That collision is how "at the cap" is detected;
 * concurrent callers are serialized by MongoDB, not by this process.
 */
export async function runHeavy<T>(
  userId: string,
  fn: () => Promise<T>,
  now: Date = new Date(),
): Promise<{ result: T; usage: HeavyUsage }> {
  const uid = new mongoose.Types.ObjectId(userId);
  const day = utcDay(now);
  const cap = heavyCap();

  // E11000 can mean "at the cap" (the guarded upsert collided with the existing doc) or
  // a first-run insert race between two concurrent upserts. A retry disambiguates: the
  // doc now exists, so a second E11000 can only be the cap.
  let reserved: { heavy: number } | null = null;
  for (let attempt = 1; attempt <= 2 && !reserved; attempt++) {
    try {
      reserved = await AssistUsage.findOneAndUpdate(
        { userId: uid, day, heavy: { $lt: cap } },
        { $inc: { heavy: 1 } },
        { upsert: true, returnDocument: 'after' },
      ).lean();
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
      if (attempt === 2) {
        const capped = new AssistError('assist_daily_cap') as AssistError & { resetsAt: Date };
        capped.resetsAt = new Date(day.getTime() + DAY_MS);
        throw capped;
      }
    }
  }

  try {
    const result = await fn();
    return { result, usage: toUsage(reserved?.heavy ?? 0, cap, day) };
  } catch (err) {
    // Refund only when nothing was billed (key missing / 401 / 403). Every other failure,
    // including invalid or unparseable model output, may have consumed provider capacity;
    // refunding those would let crafted input mint unlimited runs. Refund goes to the
    // charged `day` captured above, once, floored at 0.
    if (err instanceof AssistError && err.code === 'assist_unavailable') {
      try {
        await AssistUsage.updateOne({ userId: uid, day, heavy: { $gt: 0 } }, { $inc: { heavy: -1 } });
      } catch (refundErr) {
        console.error('assist refund failed', { userId }, refundErr);
      }
    }
    throw err;
  }
}
