import { describe, it, expect } from 'vitest';
import { isValidTimeZone, canonicalTimeZone, zonedDayKey, zonedHour, prevDayKey, dayKeyToDate } from './zoned-day.js';
import { getStreakView } from '../modules/badges/badge.service.js';

describe('isValidTimeZone', () => {
  it('accepts IANA names and rejects junk', () => {
    expect(isValidTimeZone('America/Bogota')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('auto')).toBe(false);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
    expect(isValidTimeZone('A'.repeat(80))).toBe(false);
  });
});

describe('zonedDayKey / zonedHour', () => {
  const instant = new Date('2026-09-24T03:30:00Z');

  it("reads the date and hour on the zone's clock", () => {
    expect(zonedDayKey(instant, 'UTC')).toBe('2026-09-24');
    expect(zonedDayKey(instant, 'America/Bogota')).toBe('2026-09-23'); // UTC-5
    expect(zonedHour(instant, 'America/Bogota')).toBe(22);
    expect(zonedDayKey(instant, 'Asia/Tokyo')).toBe('2026-09-24'); // UTC+9, 12:30
  });

  it('treats midnight as hour 0, not 24', () => {
    expect(zonedHour(new Date('2026-09-24T05:00:00Z'), 'America/Bogota')).toBe(0);
  });

  it('falls back to UTC for a missing or invalid zone', () => {
    expect(zonedDayKey(instant, null)).toBe('2026-09-24');
    expect(zonedDayKey(instant, 'garbage')).toBe('2026-09-24');
  });
});

describe('prevDayKey', () => {
  it('steps back across month and year boundaries and leap days', () => {
    expect(prevDayKey('2026-03-01')).toBe('2026-02-28');
    expect(prevDayKey('2028-03-01')).toBe('2028-02-29');
    expect(prevDayKey('2026-01-01')).toBe('2025-12-31');
  });

  it('is immune to DST: subtracting 24 h on a 25-hour day lands on the wrong date, key arithmetic does not', () => {
    // 2026-11-01 is 25 h long in New York. 23:30 local that day is exactly 24 h after 23:30Z... of the prior instant day.
    const late = new Date('2026-11-02T04:30:00Z'); // 23:30 EST on 11-01
    expect(zonedDayKey(late, 'America/New_York')).toBe('2026-11-01');
    expect(zonedDayKey(new Date(late.getTime() - 24 * 3_600_000), 'America/New_York')).toBe('2026-11-01'); // the trap: still today
    expect(prevDayKey('2026-11-01')).toBe('2026-10-31');
  });
});

describe('dayKeyToDate', () => {
  it('is that date at 00:00 UTC', () => {
    expect(dayKeyToDate('2026-09-23').toISOString()).toBe('2026-09-23T00:00:00.000Z');
  });
});

describe('getStreakView in a user timezone', () => {
  const streak = (lastActiveDate: string, timezone?: string) => ({ current: 3, longest: 5, lastActiveDate: new Date(lastActiveDate), timezone });

  it('keeps an evening user alive that UTC days would have broken', () => {
    // Bogota (UTC-5): last active Tue 18:30 local = Tue 23:30Z; checked Wed 20:00 local = Thu 01:00Z.
    const last = '2026-09-22T23:30:00Z';
    const now = new Date('2026-09-24T01:00:00Z');
    expect(getStreakView(streak(last), now).current).toBe(0); // UTC: Tuesday -> Thursday, two days
    expect(getStreakView(streak(last, 'America/Bogota'), now).current).toBe(3); // local: Tuesday -> Wednesday
  });

  it('is alive today and yesterday, dead after', () => {
    const tz = 'America/Bogota';
    const last = '2026-09-24T15:00:00Z'; // Thu 10:00 local
    expect(getStreakView(streak(last, tz), new Date('2026-09-24T22:00:00Z')).current).toBe(3); // same local day
    expect(getStreakView(streak(last, tz), new Date('2026-09-25T20:00:00Z')).current).toBe(3); // next local day
    expect(getStreakView(streak(last, tz), new Date('2026-09-26T20:00:00Z')).current).toBe(0); // two days on
  });

  it('keeps the longest streak whatever the state', () => {
    expect(getStreakView(streak('2020-01-01T00:00:00Z', 'UTC'), new Date('2026-09-24T00:00:00Z')).longest).toBe(5);
  });
});

describe('canonicalTimeZone', () => {
  it('normalises case variants to the canonical name', () => {
    expect(canonicalTimeZone('america/bogota')).toBe('America/Bogota');
    expect(canonicalTimeZone('AMERICA/BOGOTA')).toBe('America/Bogota');
  });
  it('rejects invalid, empty and oversized input', () => {
    expect(canonicalTimeZone('Not/AZone')).toBeNull();
    expect(canonicalTimeZone('')).toBeNull();
    expect(canonicalTimeZone('A'.repeat(51))).toBeNull();
    expect(canonicalTimeZone(42)).toBeNull();
  });
});
