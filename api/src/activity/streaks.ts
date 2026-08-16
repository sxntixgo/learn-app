// Streaks, derived not stored (design §10 / §15). Current and longest
// streak are computed fresh from activity_events every time they are asked
// for — never a stored counter, which is exactly what drifts the first time
// a bug is fixed or a row backfilled. A "day" is a calendar day in the
// student's IANA timezone; conversion happens here, at aggregation time,
// never by comparing raw UTC timestamps.

export interface StreakEvent {
  occurredAt: Date | string;
}

export interface Streaks {
  current: number;
  longest: number;
}

/**
 * The calendar date (YYYY-MM-DD) `instant` falls on in `timeZone`.
 *
 * `en-CA` is a locale trick, not a nod to Canada: its date formatting is
 * ISO-shaped (YYYY-MM-DD) with no extra punctuation to strip, so this is
 * the whole implementation rather than a substring dance.
 */
export function localDateKey(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/**
 * `key` shifted by `deltaDays` calendar days. Pure calendar-date arithmetic
 * (UTC-anchored on purpose): once an instant has been reduced to a
 * YYYY-MM-DD key via localDateKey, walking to its neighbor is a date-only
 * operation with no further timezone involved — the zone has already done
 * its job.
 */
export function addDaysToKey(key: string, deltaDays: number): string {
  const [year, month, day] = key.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day));
  shifted.setUTCDate(shifted.getUTCDate() + deltaDays);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Computes current and longest streak from raw event timestamps alone.
 *
 * - "Current" counts back from today (in `timezone`); the first missing day
 *   breaks it. Today itself is allowed to be empty — the student may not
 *   have studied yet — without breaking a streak that ran through
 *   yesterday, so the walk starts at today if today has an event, else at
 *   yesterday.
 * - "Longest" is the longest run of consecutive local days with at least
 *   one event, anywhere in the history given.
 * - Multiple events on the same local day collapse to one day (a Set of
 *   date keys), matching the "engaged that day" semantics a heatmap cell
 *   and a streak both want.
 */
export function computeStreaks(events: readonly StreakEvent[], timezone: string, now: Date = new Date()): Streaks {
  const dayKeys = new Set(events.map((e) => localDateKey(new Date(e.occurredAt), timezone)));

  const longest = longestRun(dayKeys);
  const current = currentRun(dayKeys, localDateKey(now, timezone));

  return { current, longest };
}

function longestRun(dayKeys: ReadonlySet<string>): number {
  const sorted = [...dayKeys].sort();
  let longest = 0;
  let run = 0;
  let prev: string | null = null;

  for (const key of sorted) {
    run = prev !== null && addDaysToKey(prev, 1) === key ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = key;
  }

  return longest;
}

function currentRun(dayKeys: ReadonlySet<string>, todayKey: string): number {
  let cursor = dayKeys.has(todayKey) ? todayKey : addDaysToKey(todayKey, -1);
  let count = 0;

  while (dayKeys.has(cursor)) {
    count += 1;
    cursor = addDaysToKey(cursor, -1);
  }

  return count;
}
