import type pg from 'pg';
import { streaksFromDayKeys, localDateKey, type Streaks } from './streaks.ts';

// ---------------------------------------------------------------------------
// THE DISTINCT DAYS A LEARNER WAS ACTIVE — the input a streak actually needs.
//
// Streaks are derived, never stored (design §10/§15), so every profile view,
// every dashboard load and every progression evaluation recomputes them from
// `activity_events`. Three call sites each did that with the same query:
//
//     select occurred_at from activity_events where user_id = $1 order by ...
//
// Unbounded, one row per event, and then `computeStreaks` collapsed the lot
// into a Set of at most ~365 date keys on its first line. Everything past the
// first event of each day was read from disk, sent over the wire, allocated
// as a Date and formatted through Intl purely to be discarded.
//
// The cost is not uniform across those three:
//
//   - profile/load.ts runs on every profile view INCLUDING anonymous ones, so
//     the work is reachable without an account.
//   - progression/facts.ts runs on every lesson completion, which is the bad
//     one: the more a learner uses the platform, the more history there is to
//     re-read on each of their actions.
//
// So the collapse moves to Postgres, which can answer it from
// `idx_activity_events_user_occurred` and returns one row per day. Same
// semantics, bounded result.
//
// This makes the agreement between Postgres's `at time zone` bucketing and
// `localDateKey`'s Intl bucketing load-bearing. It was already relied on —
// `profile/load.ts` matched SQL-produced heatmap keys against a JS-produced
// `todayKey` — but relied on it silently. `day-keys.test.ts` now pins it.
// ---------------------------------------------------------------------------

/**
 * The distinct calendar days, in `timezone`, on which `userId` did anything —
 * as `YYYY-MM-DD` keys, the same form `localDateKey` produces.
 *
 * Bounded by the number of days the account has been active, not by how much
 * it did on them.
 */
export async function loadActivityDayKeys(
  client: Pick<pg.PoolClient, 'query'>,
  userId: string,
  timezone: string,
): Promise<Set<string>> {
  const { rows } = await client.query<{ day: string }>(
    `select distinct (occurred_at at time zone $2)::date::text as day
       from activity_events
      where user_id = $1`,
    [userId, timezone],
  );
  return new Set(rows.map((row) => row.day));
}

/**
 * Current and longest streak for `userId`, straight from the database.
 *
 * The one place the three former copies of that query now live. `now` is a
 * parameter so callers that already fixed an instant for the rest of their
 * response (the heatmap picks `todayKey` from it) stay consistent with it
 * rather than sampling the clock a second time mid-request.
 */
export async function loadStreaks(
  client: Pick<pg.PoolClient, 'query'>,
  userId: string,
  timezone: string,
  now: Date = new Date(),
): Promise<Streaks> {
  const dayKeys = await loadActivityDayKeys(client, userId, timezone);
  return streaksFromDayKeys(dayKeys, localDateKey(now, timezone));
}
