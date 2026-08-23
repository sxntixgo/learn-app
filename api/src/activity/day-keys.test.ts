import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadActivityDayKeys, loadStreaks } from './day-keys.ts';
import { computeStreaks, localDateKey } from './streaks.ts';

const { Pool } = pg;

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is not set — required to run day-keys.test.ts');
}

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const pool = new Pool({ connectionString });

// Mirrors every other DB-touching test file's own copy — each owns its
// migration bootstrap; no shared util exists in this codebase.
async function applyMigrations(): Promise<void> {
  await pool.query(`
    create table if not exists schema_migrations (
      version     text primary key,
      applied_at  timestamptz not null default now()
    )
  `);
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await pool.query<{ version: string }>('select version from schema_migrations');
  const applied = new Set(rows.map((r) => r.version));

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    try {
      await pool.query(sql);
      await pool.query('insert into schema_migrations (version) values ($1) on conflict do nothing', [version]);
    } catch (err) {
      if ((err as { code?: string }).code !== '42P07') throw err;
    }
  }
}

// Fixtures are per-run and NOT torn down, the choice award.test.ts documents:
// a row with an activity_events row pointing at it cannot be deleted at all
// (§10's append-only trigger rejects the DELETE a cascade would issue).
const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`.replace(/[^a-z0-9]/gi, '').toLowerCase();

async function makeUser(label: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into users (display_name, timezone) values ($1, null) returning id`,
    [`DayKeys Test ${label} ${RUN_ID}`],
  );
  return rows[0]!.id;
}

async function addEvents(userId: string, instants: readonly string[]): Promise<void> {
  for (const iso of instants) {
    await pool.query(`insert into activity_events (user_id, type, occurred_at) values ($1, 'lesson_completed', $2)`, [
      userId,
      iso,
    ]);
  }
}

beforeAll(async () => {
  await applyMigrations();
}, 60_000);

afterAll(async () => {
  await pool.end();
});

/**
 * THE AGREEMENT THIS MODULE NOW RESTS ON.
 *
 * `loadActivityDayKeys` moved day-bucketing out of JavaScript and into
 * Postgres, so `(occurred_at at time zone $tz)::date` and `localDateKey`'s
 * `Intl.DateTimeFormat` must land on the same calendar day for every instant.
 * The codebase already depended on this quietly — profile/load.ts matched
 * SQL-produced heatmap keys against a JS-produced `todayKey` — but nothing
 * checked it. If Node and Postgres ever ship different tzdata, this is the
 * test that says so, rather than a streak silently going wrong at a DST edge.
 */
describe('Postgres and Intl bucket an instant into the same local day', () => {
  // Chosen for the awkward cases, not for coverage: half- and quarter-hour
  // offsets, a 30-minute DST shift (Lord Howe), a southern-hemisphere
  // transition, and the far side of the date line.
  const ZONES = [
    'UTC',
    'America/New_York',
    'Europe/Madrid',
    'Asia/Kolkata',
    'Asia/Kathmandu',
    'Australia/Lord_Howe',
    'Pacific/Chatham',
    'America/Santiago',
    'Pacific/Kiritimati',
    'Pacific/Niue',
  ];

  // Each pair straddles a boundary: the instant before and the instant of a
  // DST jump, a midnight, a year end, and a leap day.
  const INSTANTS = [
    '2026-03-08T06:59:59Z',
    '2026-03-08T07:00:00Z',
    '2026-11-01T05:59:59Z',
    '2026-11-01T06:00:00Z',
    '2026-03-29T00:59:59Z',
    '2026-03-29T01:00:00Z',
    '2026-10-25T00:59:59Z',
    '2026-10-25T01:00:00Z',
    '2026-04-05T15:59:59Z',
    '2026-04-05T16:00:00Z',
    '2025-12-31T23:59:59Z',
    '2026-01-01T00:00:00Z',
    '2024-02-29T13:45:00Z',
    '2026-06-15T12:00:00Z',
    '2026-02-28T23:30:00Z',
  ];

  it.each(ZONES)('agrees for every boundary instant in %s', async (timezone) => {
    const { rows } = await pool.query<{ t: Date; pg: string }>(
      `select t, (t at time zone $2)::date::text as pg from unnest($1::timestamptz[]) as t`,
      [INSTANTS, timezone],
    );
    expect(rows).toHaveLength(INSTANTS.length);

    const disagreements = rows
      .filter((row) => localDateKey(row.t, timezone) !== row.pg)
      .map((row) => `${row.t.toISOString()}: postgres=${row.pg} intl=${localDateKey(row.t, timezone)}`);

    expect(disagreements).toEqual([]);
  });
});

describe('loadActivityDayKeys', () => {
  it('returns one key per active day, however many events fell on it', async () => {
    const userId = await makeUser('collapse');
    // Nine events, three days. The whole point of the change: what comes back
    // is bounded by days, not by how busy those days were.
    await addEvents(userId, [
      '2026-05-01T01:00:00Z',
      '2026-05-01T09:00:00Z',
      '2026-05-01T23:59:00Z',
      '2026-05-02T00:00:00Z',
      '2026-05-02T12:00:00Z',
      '2026-05-02T18:30:00Z',
      '2026-05-09T08:00:00Z',
      '2026-05-09T08:00:01Z',
      '2026-05-09T20:00:00Z',
    ]);

    const keys = await loadActivityDayKeys(pool, userId, 'UTC');
    expect([...keys].sort()).toEqual(['2026-05-01', '2026-05-02', '2026-05-09']);
  });

  it('makes POSTGRES do the collapsing — one ROW per day, not one per event', async () => {
    // The reason this module exists, and the one property a Set-returning
    // signature hides: `new Set(...)` dedupes just as well without `distinct`,
    // so every assertion about the returned keys passes for the unbounded
    // query too. Dropping `distinct` has to fail something, or the fix is
    // free to rot back into the query it replaced.
    const userId = await makeUser('rowcount');
    const busyDay = Array.from({ length: 40 }, (_, i) => `2026-08-03T${String(i % 24).padStart(2, '0')}:${String(i).padStart(2, '0')}:00Z`);
    await addEvents(userId, busyDay);

    let rowsReturned = -1;
    const counting = {
      query: async (...args: Parameters<typeof pool.query>) => {
        const result = await (pool.query as (...a: unknown[]) => Promise<{ rows: unknown[] }>)(...args);
        rowsReturned = result.rows.length;
        return result;
      },
    } as unknown as Parameters<typeof loadActivityDayKeys>[0];

    const keys = await loadActivityDayKeys(counting, userId, 'UTC');

    expect([...keys]).toEqual(['2026-08-03']);
    // 40 events on one day must cross the wire as a single row.
    expect(rowsReturned, 'the query returned a row per event, not per day').toBe(1);
  });

  it('buckets by the SUBJECT timezone, not UTC', async () => {
    const userId = await makeUser('tz');
    // 03:00Z on the 2nd is still the evening of the 1st in New York, so the
    // two zones must disagree about the day — otherwise this test would pass
    // for a version that ignored the timezone argument entirely.
    await addEvents(userId, ['2026-05-02T03:00:00Z']);

    expect([...(await loadActivityDayKeys(pool, userId, 'UTC'))]).toEqual(['2026-05-02']);
    expect([...(await loadActivityDayKeys(pool, userId, 'America/New_York'))]).toEqual(['2026-05-01']);
  });

  it('returns nothing for an account with no activity', async () => {
    const userId = await makeUser('empty');
    expect(await loadActivityDayKeys(pool, userId, 'UTC')).toEqual(new Set());
  });

  it('never sees another account\'s days', async () => {
    const mine = await makeUser('mine');
    const theirs = await makeUser('theirs');
    await addEvents(mine, ['2026-07-01T10:00:00Z']);
    await addEvents(theirs, ['2026-07-02T10:00:00Z']);

    expect([...(await loadActivityDayKeys(pool, mine, 'UTC'))]).toEqual(['2026-07-01']);
  });
});

describe('loadStreaks matches the event-by-event computation it replaced', () => {
  // The regression guard for the refactor itself: the old code read every
  // event and called computeStreaks. Both paths must still agree, so this
  // runs them side by side on the same rows.
  async function bothWays(userId: string, timezone: string, now: Date) {
    const { rows } = await pool.query<{ occurred_at: Date }>(
      'select occurred_at from activity_events where user_id = $1 order by occurred_at asc',
      [userId],
    );
    return {
      viaEvents: computeStreaks(
        rows.map((r) => ({ occurredAt: r.occurred_at })),
        timezone,
        now,
      ),
      viaDayKeys: await loadStreaks(pool, userId, timezone, now),
    };
  }

  it('agrees on a run ending today, with duplicate events per day', async () => {
    const userId = await makeUser('streak-today');
    await addEvents(userId, [
      '2026-06-10T08:00:00Z',
      '2026-06-10T09:00:00Z',
      '2026-06-11T08:00:00Z',
      '2026-06-12T08:00:00Z',
      '2026-06-12T23:00:00Z',
    ]);

    const now = new Date('2026-06-12T12:00:00Z');
    const { viaEvents, viaDayKeys } = await bothWays(userId, 'UTC', now);
    expect(viaDayKeys).toEqual(viaEvents);
    expect(viaDayKeys).toEqual({ current: 3, longest: 3 });
  });

  it('agrees when the run ended yesterday and today is still empty', async () => {
    const userId = await makeUser('streak-yesterday');
    await addEvents(userId, ['2026-06-20T08:00:00Z', '2026-06-21T08:00:00Z']);

    const now = new Date('2026-06-22T09:00:00Z');
    const { viaEvents, viaDayKeys } = await bothWays(userId, 'UTC', now);
    expect(viaDayKeys).toEqual(viaEvents);
    // Today may be empty without breaking a streak that ran through
    // yesterday — computeStreaks' documented rule, preserved here.
    expect(viaDayKeys).toEqual({ current: 2, longest: 2 });
  });

  it('agrees when a gap makes the longest run an earlier one', async () => {
    const userId = await makeUser('streak-gap');
    await addEvents(userId, [
      '2026-01-05T08:00:00Z',
      '2026-01-06T08:00:00Z',
      '2026-01-07T08:00:00Z',
      '2026-01-08T08:00:00Z',
      '2026-02-01T08:00:00Z',
    ]);

    const now = new Date('2026-02-01T20:00:00Z');
    const { viaEvents, viaDayKeys } = await bothWays(userId, 'UTC', now);
    expect(viaDayKeys).toEqual(viaEvents);
    expect(viaDayKeys).toEqual({ current: 1, longest: 4 });
  });

  it('agrees across a DST transition in the subject timezone', async () => {
    const userId = await makeUser('streak-dst');
    // 08:00 local on each of three days spanning the US spring-forward, when
    // the UTC offset changes underneath the run. Bucketing by UTC would still
    // give three consecutive days here, so the assertion that matters is the
    // agreement between the two implementations.
    await addEvents(userId, ['2026-03-07T13:00:00Z', '2026-03-08T12:00:00Z', '2026-03-09T12:00:00Z']);

    const now = new Date('2026-03-09T20:00:00Z');
    const { viaEvents, viaDayKeys } = await bothWays(userId, 'America/New_York', now);
    expect(viaDayKeys).toEqual(viaEvents);
    expect(viaDayKeys).toEqual({ current: 3, longest: 3 });
  });

  it('agrees that an account with no activity has no streak', async () => {
    const userId = await makeUser('streak-empty');
    const now = new Date('2026-06-01T00:00:00Z');
    const { viaEvents, viaDayKeys } = await bothWays(userId, 'UTC', now);
    expect(viaDayKeys).toEqual(viaEvents);
    expect(viaDayKeys).toEqual({ current: 0, longest: 0 });
  });
});
