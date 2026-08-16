import { describe, it, expect } from 'vitest';
import { computeStreaks, localDateKey, addDaysToKey } from './streaks.ts';

function utc(iso: string): Date {
  return new Date(iso);
}

describe('localDateKey', () => {
  it('formats a UTC instant as YYYY-MM-DD in the given zone', () => {
    expect(localDateKey(utc('2026-08-16T12:00:00Z'), 'UTC')).toBe('2026-08-16');
  });

  it('the point of the whole task: an evening event disagrees with UTC about the day', () => {
    // 2026-08-15T23:30:00 in America/Denver (UTC-6, MDT in August) is
    // 2026-08-16T05:30:00Z — the NEXT calendar day in UTC. A naive
    // `occurred_at.toISOString().slice(0, 10)` bucket would put this event
    // on 2026-08-16; the student's own calendar day was 2026-08-15.
    const instant = utc('2026-08-16T05:30:00Z');
    expect(localDateKey(instant, 'America/Denver')).toBe('2026-08-15');
    expect(localDateKey(instant, 'UTC')).toBe('2026-08-16');
  });
});

describe('addDaysToKey', () => {
  it('adds and subtracts days across a month boundary', () => {
    expect(addDaysToKey('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDaysToKey('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('computeStreaks', () => {
  const tz = 'UTC';

  it('a run crossing a month boundary counts as one unbroken streak', () => {
    const events = [
      { occurredAt: utc('2026-01-30T10:00:00Z') },
      { occurredAt: utc('2026-01-31T10:00:00Z') },
      { occurredAt: utc('2026-02-01T10:00:00Z') },
      { occurredAt: utc('2026-02-02T10:00:00Z') },
    ];
    const now = utc('2026-02-02T20:00:00Z');
    const { current, longest } = computeStreaks(events, tz, now);
    expect(current).toBe(4);
    expect(longest).toBe(4);
  });

  it('a gap breaks the streak — longest survives, current does not', () => {
    const events = [
      { occurredAt: utc('2026-02-01T10:00:00Z') },
      { occurredAt: utc('2026-02-02T10:00:00Z') },
      { occurredAt: utc('2026-02-03T10:00:00Z') },
      // gap: no event on 2026-02-04
      { occurredAt: utc('2026-02-05T10:00:00Z') },
    ];
    const now = utc('2026-02-05T20:00:00Z');
    const { current, longest } = computeStreaks(events, tz, now);
    expect(current).toBe(1);
    expect(longest).toBe(3);
  });

  it('multiple events on one calendar day count once toward the streak', () => {
    const events = [
      { occurredAt: utc('2026-02-01T08:00:00Z') },
      { occurredAt: utc('2026-02-01T09:00:00Z') },
      { occurredAt: utc('2026-02-01T22:00:00Z') },
      { occurredAt: utc('2026-02-02T08:00:00Z') },
    ];
    const now = utc('2026-02-02T20:00:00Z');
    const { current, longest } = computeStreaks(events, tz, now);
    expect(current).toBe(2);
    expect(longest).toBe(2);
  });

  it('today having no events yet does not break a streak that ran through yesterday', () => {
    const events = [
      { occurredAt: utc('2026-02-01T10:00:00Z') },
      { occurredAt: utc('2026-02-02T10:00:00Z') },
    ];
    // "now" is 2026-02-03, but the student hasn't studied yet today.
    const now = utc('2026-02-03T08:00:00Z');
    const { current, longest } = computeStreaks(events, tz, now);
    expect(current).toBe(2);
    expect(longest).toBe(2);
  });

  it('a gap that includes both today and yesterday zeroes the current streak', () => {
    const events = [{ occurredAt: utc('2026-02-01T10:00:00Z') }];
    const now = utc('2026-02-05T08:00:00Z');
    const { current, longest } = computeStreaks(events, tz, now);
    expect(current).toBe(0);
    expect(longest).toBe(1);
  });

  it('no events at all: both streaks are zero', () => {
    expect(computeStreaks([], tz, utc('2026-02-05T08:00:00Z'))).toEqual({ current: 0, longest: 0 });
  });

  it('UTC and the local zone disagree about which day an event falls on', () => {
    // 23:30 local in America/Denver on 2026-08-15 is 05:30 UTC on
    // 2026-08-16 — the next day in UTC. Bucketing naively by UTC date would
    // see two consecutive UTC-day events (Aug 16 and Aug 17) as a streak of
    // 2 ending "today" (Aug 17 UTC); bucketing correctly by the student's
    // zone sees a single local day (Aug 15) with no event on Aug 16 local —
    // a streak of 1, broken.
    const events = [
      { occurredAt: utc('2026-08-16T05:30:00Z') }, // 2026-08-15 23:30 Denver
    ];
    const denver = 'America/Denver';

    // "Now" is the same evening, a few minutes later — still 2026-08-15
    // local, but already 2026-08-16 in UTC.
    const now = utc('2026-08-16T05:45:00Z');

    expect(localDateKey(now, denver)).toBe('2026-08-15');
    const { current, longest } = computeStreaks(events, denver, now);
    expect(current).toBe(1);
    expect(longest).toBe(1);

    // Bucketing the SAME data in UTC instead would (wrongly) place the
    // event on 2026-08-16, and "now" also reads as 2026-08-16 in UTC — so a
    // UTC bucketing bug would silently produce the same-looking answer here.
    // The real proof is the date key itself: the event and "now" land on
    // DIFFERENT calendar days in UTC but the SAME calendar day in Denver.
    expect(localDateKey(events[0]!.occurredAt, 'UTC')).toBe('2026-08-16');
    expect(localDateKey(now, 'UTC')).toBe('2026-08-16');
    expect(localDateKey(events[0]!.occurredAt, denver)).toBe(localDateKey(now, denver));
  });

  it('accepts ISO string occurredAt values, not just Date objects', () => {
    const events = [{ occurredAt: '2026-02-01T10:00:00Z' }, { occurredAt: '2026-02-02T10:00:00Z' }];
    const { current, longest } = computeStreaks(events, tz, utc('2026-02-02T20:00:00Z'));
    expect(current).toBe(2);
    expect(longest).toBe(2);
  });
});
