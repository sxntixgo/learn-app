import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { buildServer } from '../index.ts';
import { setPool, closePool } from '../db.ts';
import type { Actor } from '../policy/can.ts';

// =============================================================================
// TWO SIMULTANEOUS COMPLETIONS MUST NOT DOUBLE-AWARD (design §9.3).
//
// Criteria are evaluated synchronously on every progress write, so two writes
// landing at once genuinely race to award the same badge. The guarantee is
// `user_badges`' unique (user_id, badge_id) plus an `insert ... on conflict do
// nothing returning`: exactly one statement returns a row, and only that one
// emits the activity event and reports the award. This file is the proof.
//
// Same house pattern as routes/setup.test.ts's "two concurrent claims": two
// SERVERS, one Promise.all, and the pool pre-warmed first — see warmPool.
// =============================================================================

const { Pool } = pg;

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is not set — required to run award-concurrency.test.ts');
}

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

const pool = new Pool({ connectionString });

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
      const code = (err as { code?: string }).code;
      if (code !== '42P07' /* duplicate_table */) throw err;
    }
  }
}

/**
 * Opens `n` connections and releases them back to the pool.
 *
 * Lifted verbatim from routes/setup.test.ts, for the identical reason: without
 * it the "concurrent" requests are not concurrent where it counts. The first
 * handler gets a warm idle client and finishes its whole transaction in a few
 * sub-millisecond round trips while the second is still doing a TCP connect
 * and auth handshake — so it arrives to find the badge already awarded and
 * takes the `not exists` fast path, which is NOT the code path under test.
 * Warming the pool first makes both handlers reach their `insert into
 * user_badges` in the same tick, which is the situation the unique constraint
 * exists for.
 */
async function warmPool(n: number): Promise<void> {
  const clients = await Promise.all(Array.from({ length: n }, () => pool.connect()));
  for (const client of clients) client.release();
}

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`.replace(/[^a-z0-9]/gi, '').toLowerCase();
const COURSE_SLUG = `award-race-course-${RUN_ID}`;
const BADGE_SLUG = `award-race-badge-${RUN_ID}`;
const LESSON_A = 'race-lesson-a';
const LESSON_B = 'race-lesson-b';

let actor: Actor;
let badgeId: string;

interface AwardedBody {
  awarded: { badges: Array<{ slug: string }>; degrees: Array<{ slug: string }> };
}

describe('two simultaneous completions award a badge exactly once', () => {
  beforeAll(async () => {
    await applyMigrations();
    setPool(pool);

    const user = await pool.query<{ id: string }>(
      `insert into users (display_name, timezone) values ($1, null) returning id`,
      [`Award Race User ${RUN_ID}`],
    );
    actor = { id: user.rows[0]!.id, roles: ['student'] };

    const course = await pool.query<{ id: string }>(
      `insert into courses (slug, title, visibility) values ($1, $2, 'open') returning id`,
      [COURSE_SLUG, 'Award Race Course'],
    );
    const courseId = course.rows[0]!.id;

    const mod = await pool.query<{ id: string }>(
      `insert into modules (course_id, key, title, position) values ($1, 'mod-a', 'Module A', 0) returning id`,
      [courseId],
    );
    const moduleId = mod.rows[0]!.id;

    for (const [index, slug] of [LESSON_A, LESSON_B].entries()) {
      await pool.query(
        `insert into lessons
           (course_id, module_id, lesson_key, slug, title, kind, position, source_path, content_hash, blocks)
         values ($1, $2, $3, $4, $5, 'lesson', $6, $7, $8, '[]')`,
        [courseId, moduleId, `race-${index}`, slug, `Race Lesson ${index}`, index, `race-${index}.md`, `race-hash-${RUN_ID}-${index}`],
      );
    }

    // ONE lesson is enough to earn it, so BOTH requests find the criterion
    // satisfied and both reach the insert. A badge needing two lessons would
    // be earned by whichever request happened to run second and would not
    // race at all.
    const badge = await pool.query<{ id: string }>(
      `insert into badges (slug, title, description, source, criteria)
       values ($1, 'The Race Badge', null, 'admin', $2::jsonb) returning id`,
      [BADGE_SLUG, JSON.stringify({ type: 'lessons_completed', count: 1 })],
    );
    badgeId = badge.rows[0]!.id;
  });

  afterAll(async () => {
    // No teardown of the fixture rows: the awards below write append-only
    // activity_events pointing at them, and design §10's trigger refuses the
    // DELETE a cascade would have to issue. Unique per-run slugs instead —
    // the same choice routes/progress.test.ts documents.
    await closePool();
  });

  it('yields one user_badges row, one badge_awarded event, and one reported award', async () => {
    const serverA = await buildServer({ actor });
    const serverB = await buildServer({ actor });

    try {
      await warmPool(2);

      // Genuinely in flight at once: both are dispatched before either
      // transaction commits, served by two servers over two pool
      // connections, so nothing serializes them but the database.
      const [a, b] = await Promise.all([
        serverA.inject({
          method: 'POST',
          url: `/api/v1/courses/${COURSE_SLUG}/lessons/${LESSON_A}/progress`,
          payload: { state: 'complete' },
        }),
        serverB.inject({
          method: 'POST',
          url: `/api/v1/courses/${COURSE_SLUG}/lessons/${LESSON_B}/progress`,
          payload: { state: 'complete' },
        }),
      ]);

      // Both writes are legitimate — they complete different lessons — so
      // both succeed. It is the AWARD that must happen once.
      expect(a.statusCode).toBe(200);
      expect(b.statusCode).toBe(200);

      const awardedBy = [a, b]
        .map((res) => JSON.parse(res.payload) as AwardedBody)
        .filter((body) => body.awarded.badges.some((badge) => badge.slug === BADGE_SLUG));
      expect(awardedBy).toHaveLength(1);

      const rows = await pool.query<{ c: number }>(
        'select count(*)::int as c from user_badges where user_id = $1 and badge_id = $2',
        [actor.id, badgeId],
      );
      expect(rows.rows[0]!.c).toBe(1);

      const events = await pool.query<{ c: number }>(
        `select count(*)::int as c from activity_events
          where user_id = $1 and type = 'badge_awarded' and badge_id = $2`,
        [actor.id, badgeId],
      );
      expect(events.rows[0]!.c).toBe(1);
    } finally {
      await serverA.close();
      await serverB.close();
    }
  });
});
