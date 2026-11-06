/**
 * Calendar-day arithmetic in a user's own IANA timezone.
 *
 * Streaks, the streak warning and the activity heatmap all count "days". A day is the user's
 * local calendar day, so a user in UTC-5 who works every evening keeps their streak. Days are
 * handled as 'YYYY-MM-DD' keys rather than by subtracting 24 h from an instant, because a day
 * is 23 or 25 hours long across a DST change and instant arithmetic then lands on the wrong date.
 */

// Keyed by the canonical zone name only, so case variants ('america/bogota') cannot grow it.
const formatters = new Map<string, Intl.DateTimeFormat>();

function buildFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const hit = formatters.get(timeZone);
  if (hit) return hit;
  const f = buildFormatter(timeZone);
  formatters.set(f.resolvedOptions().timeZone, f);
  return f;
}

/** The runtime's canonical spelling of an IANA zone ('america/bogota' -> 'America/Bogota'), or null if invalid. */
export function canonicalTimeZone(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 50) return null;
  try {
    return buildFormatter(value).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** True for a string the runtime accepts as an IANA timezone name (e.g. 'America/Bogota'). */
export function isValidTimeZone(value: unknown): value is string {
  return canonicalTimeZone(value) !== null;
}

/** A stored zone or UTC: a missing or no-longer-valid name must not break day counting. */
function zoneOrUtc(timeZone: string | null | undefined): string {
  return isValidTimeZone(timeZone) ? timeZone : 'UTC';
}

function partsOf(date: Date, timeZone: string | null | undefined): { year: string; month: string; day: string; hour: number } {
  const out = { year: '', month: '', day: '', hour: 0 };
  for (const p of formatterFor(zoneOrUtc(timeZone)).formatToParts(date)) {
    if (p.type === 'year') out.year = p.value;
    else if (p.type === 'month') out.month = p.value;
    else if (p.type === 'day') out.day = p.value;
    else if (p.type === 'hour') out.hour = Number(p.value);
  }
  return out;
}

/** The calendar date `date` falls on in `timeZone`, as 'YYYY-MM-DD'. */
export function zonedDayKey(date: Date, timeZone?: string | null): string {
  const p = partsOf(date, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** The hour of day (0-23) on `timeZone`'s clock. */
export function zonedHour(date: Date, timeZone?: string | null): number {
  return partsOf(date, timeZone).hour;
}

/** The day before a 'YYYY-MM-DD' key. Pure calendar arithmetic, immune to DST. */
export function prevDayKey(key: string): string {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** A day key as a Date at 00:00 UTC, the form the heatmap collections store their day in. */
export function dayKeyToDate(key: string): Date {
  return new Date(`${key}T00:00:00Z`);
}
