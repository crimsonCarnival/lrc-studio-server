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

const toUsage = (used: number, day: Date): HeavyUsage => {
  const cap = heavyCap();
  return { used, cap, remaining: Math.max(0, cap - used), resetsAt: new Date(day.getTime() + DAY_MS) };
};

export async function getHeavyUsage(userId: string, now: Date = new Date()): Promise<HeavyUsage> {
  const day = utcDay(now);
  const doc = await AssistUsage.findOne({ userId: new mongoose.Types.ObjectId(userId), day }).lean();
  return toUsage(doc?.heavy ?? 0, day);
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

  let reserved: { heavy: number } | null;
  try {
    reserved = await AssistUsage.findOneAndUpdate(
      { userId: uid, day, heavy: { $lt: cap } },
      { $inc: { heavy: 1 } },
      { upsert: true, returnDocument: 'after' },
    ).lean();
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      const capped = new AssistError('assist_daily_cap') as AssistError & { resetsAt: Date };
      capped.resetsAt = new Date(day.getTime() + DAY_MS);
      throw capped;
    }
    throw err;
  }

  try {
    const result = await fn();
    return { result, usage: toUsage(reserved?.heavy ?? 0, day) };
  } catch (err) {
    // Refund to the day that was charged (captured above), once, floored at 0.
    await AssistUsage.updateOne({ userId: uid, day, heavy: { $gt: 0 } }, { $inc: { heavy: -1 } });
    throw err;
  }
}
