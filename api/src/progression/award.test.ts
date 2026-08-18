import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { evaluateAndAward } from './award.ts';
import type { AwardNotice } from './award.ts';

const { Pool } = pg;

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is not set — required to run award.test.ts');
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
      const code = (err as { code?: string }).code;
      if (code !== '42P07' /* duplicate_table */) throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Fixtures are per-run and are NOT torn down, the same choice progress.test.ts
// documents: once a row has an activity_events row pointing at it, it cannot
// be deleted at all (design §10's append-only trigger rejects the DELETE that
// a cascade would have to issue), and every award here writes one. Unique
// per-run slugs are what keep repeated runs from colliding.
// ---------------------------------------------------------------------------

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`.replace(/[^a-z0-9]/gi, '').toLowerCase();

/** Creates a fresh learner, so each test starts with no awards of its own. */
async function makeUser(label: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into users (display_name, timezone) values ($1, null) returning id`,
    [`Award Test ${label} ${RUN_ID}`],
  );
  return rows[0]!.id;
}

/** A course with `lessonCount` live lessons in one live module. */
async function makeCourse(key: string, lessonCount: number): Promise<{ id: string; slug: string; lessonIds: string[] }> {
  const slug = `award-${key}-${RUN_ID}`;
  const course = await pool.query<{ id: string }>(
    `insert into courses (slug, title, visibility) values ($1, $2, 'open') returning id`,
    [slug, `Award Test Course ${key}`],
  );
  const courseId = course.rows[0]!.id;

  const mod = await pool.query<{ id: string }>(
    `insert into modules (course_id, key, title, position) values ($1, 'mod-a', 'Module A', 0) returning id`,
    [courseId],
  );
  const moduleId = mod.rows[0]!.id;

  const lessonIds: string[] = [];
  for (let i = 0; i < lessonCount; i++) {
    const lesson = await pool.query<{ id: string }>(
      `insert into lessons
         (course_id, module_id, lesson_key, slug, title, kind, position, source_path, content_hash, blocks)
       values ($1, $2, $3, $4, $5, 'lesson', $6, $7, $8, '[]')
       returning id`,
      [courseId, moduleId, `l-${i}`, `award-lesson-${i}`, `Lesson ${i}`, i, `l-${i}.md`, `hash-${key}-${i}`],
    );
    lessonIds.push(lesson.rows[0]!.id);
  }

  return { id: courseId, slug, lessonIds };
}

/**
 * Marks a lesson complete WITHOUT going through the progress route, so the
 * fixture leaves no activity_events row pointing at the course — which is
 * what lets the "deleting a course does not revoke" test actually delete one.
 */
async function completeLesson(userId: string, lessonId: string): Promise<void> {
  await pool.query(
    `insert into lesson_progress (user_id, lesson_id, state, completed_at, updated_at)
     values ($1, $2, 'complete', now(), now())
     on conflict (user_id, lesson_id) do update set state = 'complete', completed_at = now()`,
    [userId, lessonId],
  );
}

async function makeBadge(key: string, criteria: unknown, source: 'git' | 'admin' = 'git'): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into badges (slug, title, description, source, criteria)
     values ($1, $2, $3, $4, $5::jsonb) returning id`,
    [`award-${key}-${RUN_ID}`, `Badge ${key}`, `The ${key} badge`, source, JSON.stringify(criteria)],
  );
  return rows[0]!.id;
}

async function makeDegree(
  key: string,
  requiredSlugs: string[],
  electives?: { choose: number; from: string[] },
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into degrees (slug, title, description, required_slugs, electives_choose, electives_from)
     values ($1, $2, $3, $4::text[], $5, $6::text[]) returning id`,
    [
      `award-degree-${key}-${RUN_ID}`,
      `Degree ${key}`,
      null,
      requiredSlugs,
      electives?.choose ?? 0,
      electives?.from ?? [],
    ],
  );
  return rows[0]!.id;
}

/** Runs one evaluation pass in its own transaction, exactly as a route does. */
async function award(userId: string, trigger: Parameters<typeof evaluateAndAward>[2]): Promise<AwardNotice> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const notice = await evaluateAndAward(client, userId, trigger);
    await client.query('commit');
    return notice;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

async function countAwards(userId: string, badgeId: string): Promise<number> {
  const { rows } = await pool.query<{ c: number }>(
    'select count(*)::int as c from user_badges where user_id = $1 and badge_id = $2',
    [userId, badgeId],
  );
  return rows[0]!.c;
}

async function countBadgeEvents(userId: string, badgeId: string): Promise<number> {
  const { rows } = await pool.query<{ c: number }>(
    `select count(*)::int as c from activity_events
      where user_id = $1 and type = 'badge_awarded' and badge_id = $2`,
    [userId, badgeId],
  );
  return rows[0]!.c;
}

async function countDegreeEvents(userId: string, degreeId: string): Promise<number> {
  const { rows } = await pool.query<{ c: number }>(
    `select count(*)::int as c from activity_events
      where user_id = $1 and type = 'degree_earned' and degree_id = $2`,
    [userId, degreeId],
  );
  return rows[0]!.c;
}

/**
 * The slug `makeBadge`/`makeDegree` derive from a key.
 *
 * Assertions here are always slug-specific rather than length-based: badges
 * are GLOBAL, so every badge an earlier test in this file created is still a
 * live candidate for every later fixture learner — which is the production
 * behaviour, not an artefact.
 */
function badgeSlug(key: string): string {
  return `award-${key}-${RUN_ID}`;
}

function degreeSlug(key: string): string {
  return `award-degree-${key}-${RUN_ID}`;
}

describe('evaluateAndAward', () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('awards a satisfied badge once and emits one badge_awarded event', async () => {
    const userId = await makeUser('basic');
    const course = await makeCourse('basic', 2);
    const badgeId = await makeBadge('basic', { type: 'lessons_completed', count: 2 });

    await completeLesson(userId, course.lessonIds[0]!);
    await completeLesson(userId, course.lessonIds[1]!);

    const notice = await award(userId, 'lesson_completed');

    const awarded = notice.badges.find((b) => b.slug === badgeSlug('basic'));
    expect(awarded).toBeDefined();
    expect(awarded!.title).toBe('Badge basic');
    expect(awarded!.description).toBe('The basic badge');
    expect(await countAwards(userId, badgeId)).toBe(1);
    expect(await countBadgeEvents(userId, badgeId)).toBe(1);

    const { rows } = await pool.query<{ meta: { slug: string } }>(
      `select meta from activity_events where user_id = $1 and type = 'badge_awarded' and badge_id = $2`,
      [userId, badgeId],
    );
    expect(rows[0]!.meta.slug).toBe(badgeSlug('basic'));
  });

  it('is idempotent: a second pass awards nothing and emits no second event', async () => {
    const userId = await makeUser('idempotent');
    const course = await makeCourse('idempotent', 1);
    const badgeId = await makeBadge('idempotent', { type: 'lessons_completed', count: 1 });

    await completeLesson(userId, course.lessonIds[0]!);

    const first = await award(userId, 'lesson_completed');
    const second = await award(userId, 'lesson_completed');

    expect(first.badges.map((b) => b.slug)).toContain(badgeSlug('idempotent'));
    expect(second.badges.map((b) => b.slug)).not.toContain(badgeSlug('idempotent'));
    expect(await countAwards(userId, badgeId)).toBe(1);
    expect(await countBadgeEvents(userId, badgeId)).toBe(1);
  });

  it('does not evaluate a criterion the trigger could not have moved', async () => {
    const userId = await makeUser('filtered');
    const course = await makeCourse('filtered', 1);
    await makeBadge('filtered', { type: 'streak_days', days: 1 });

    await completeLesson(userId, course.lessonIds[0]!);
    // A streak needs an activity_events row: one active day is a streak of
    // one (design §10). This is the only fixture that needs one.
    await pool.query(
      `insert into activity_events (user_id, type, course_id, lesson_id, meta)
       values ($1, 'lesson_completed', $2, $3, '{}'::jsonb)`,
      [userId, course.id, course.lessonIds[0]!],
    );

    // `submission_graded` affects track_score only (criteria.ts's
    // TRIGGER_AFFECTS), so a streak badge is not even considered — even
    // though the learner's streak would satisfy it on any other trigger.
    const graded = await award(userId, 'submission_graded');
    expect(graded.badges.map((b) => b.slug)).not.toContain(badgeSlug('filtered'));

    // ...and it does fire on a trigger that CAN move a streak, so the test
    // above is about the filter rather than about an unsatisfiable badge.
    const completed = await award(userId, 'lesson_completed');
    expect(completed.badges.map((b) => b.slug)).toContain(badgeSlug('filtered'));
  });

  it('a badge whose criteria are not met is not awarded', async () => {
    const userId = await makeUser('unmet');
    const course = await makeCourse('unmet', 3);
    const badgeId = await makeBadge('unmet', { type: 'lessons_completed', count: 3 });

    await completeLesson(userId, course.lessonIds[0]!);

    const notice = await award(userId, 'lesson_completed');
    expect(notice.badges.map((b) => b.slug)).not.toContain(badgeSlug('unmet'));
    expect(await countAwards(userId, badgeId)).toBe(0);
  });

  it('an unparseable criteria row is skipped, not thrown on', async () => {
    const userId = await makeUser('malformed');
    const course = await makeCourse('malformed', 1);
    // A ninth criterion type nobody implemented — the shape a hand-edited
    // database or a future migration could leave behind. It must not turn
    // every progress write on the instance into a 500.
    await makeBadge('malformed', { type: 'invented_type', count: 1 });
    const goodId = await makeBadge('malformed-good', { type: 'lessons_completed', count: 1 });

    await completeLesson(userId, course.lessonIds[0]!);

    const notice = await award(userId, 'lesson_completed');
    const slugs = notice.badges.map((b) => b.slug);
    expect(slugs).toContain(badgeSlug('malformed-good'));
    expect(slugs).not.toContain(badgeSlug('malformed'));
    expect(await countAwards(userId, goodId)).toBe(1);
  });

  describe('degrees (design §9.2)', () => {
    it('awards a degree when its required courses are complete, once', async () => {
      const userId = await makeUser('degree');
      const course = await makeCourse('degree', 1);
      const degreeId = await makeDegree('req', [course.slug]);

      await completeLesson(userId, course.lessonIds[0]!);

      const first = await award(userId, 'lesson_completed');
      expect(first.degrees.map((d) => d.slug)).toContain(degreeSlug('req'));
      expect(await countDegreeEvents(userId, degreeId)).toBe(1);

      const second = await award(userId, 'lesson_completed');
      expect(second.degrees.map((d) => d.slug)).not.toContain(degreeSlug('req'));
      expect(await countDegreeEvents(userId, degreeId)).toBe(1);
    });

    it('a degree naming an unimported course is never awarded', async () => {
      const userId = await makeUser('unsatisfiable');
      const course = await makeCourse('unsatisfiable', 1);
      await makeDegree('missing', [course.slug, `award-never-imported-${RUN_ID}`]);

      await completeLesson(userId, course.lessonIds[0]!);

      const notice = await award(userId, 'lesson_completed');
      expect(notice.degrees.map((d) => d.slug)).not.toContain(degreeSlug('missing'));
    });

    it('a degree_earned badge fires in the SAME write as the degree', async () => {
      const userId = await makeUser('degreebadge');
      const course = await makeCourse('degreebadge', 1);
      await makeDegree('chain', [course.slug]);
      await makeBadge('degreebadge', { type: 'degree_earned', degree: degreeSlug('chain') });

      await completeLesson(userId, course.lessonIds[0]!);

      // Degrees are awarded before badges precisely so this holds: a badge
      // reading user_degrees must see the degree this very write earned,
      // not the one before it.
      const notice = await award(userId, 'lesson_completed');
      expect(notice.degrees.map((d) => d.slug)).toContain(degreeSlug('chain'));
      expect(notice.badges.map((b) => b.slug)).toContain(badgeSlug('degreebadge'));
    });
  });

  // ===========================================================================
  // Design §9.3: "BADGES ARE NEVER REVOKED. Editing a course must not strip a
  // badge someone earned." One test per way a course could change under an
  // award: deleted outright, archived lesson by lesson, or retuned criteria.
  // ===========================================================================
  describe('awards are never revoked', () => {
    it('deleting the course the badge was earned in leaves the award intact', async () => {
      const userId = await makeUser('coursedelete');
      const course = await makeCourse('coursedelete', 1);
      const badgeId = await makeBadge('coursedelete', { type: 'course_completed', course: course.slug });

      await completeLesson(userId, course.lessonIds[0]!);
      expect((await award(userId, 'lesson_completed')).badges.map((b) => b.slug)).toContain(
        badgeSlug('coursedelete'),
      );

      // The whole course, cascading through modules, lessons and
      // lesson_progress. `badges.course_id` is `on delete set null` and
      // `user_badges` references the badge, not the course.
      await pool.query('delete from courses where id = $1', [course.id]);

      expect(await countAwards(userId, badgeId)).toBe(1);

      // And a later evaluation does not re-award or duplicate it either.
      const after = await award(userId, 'lesson_completed');
      expect(after.badges.map((b) => b.slug)).not.toContain(badgeSlug('coursedelete'));
      expect(await countAwards(userId, badgeId)).toBe(1);
      expect(await countBadgeEvents(userId, badgeId)).toBe(1);
    });

    it('archiving the lesson the badge counted leaves the award intact', async () => {
      const userId = await makeUser('lessonarchive');
      const course = await makeCourse('lessonarchive', 1);
      const badgeId = await makeBadge('lessonarchive', { type: 'lessons_completed', count: 1 });

      await completeLesson(userId, course.lessonIds[0]!);
      expect((await award(userId, 'lesson_completed')).badges.map((b) => b.slug)).toContain(
        badgeSlug('lessonarchive'),
      );

      // What a re-import does to a lesson dropped from the manifest
      // (design §7: archived, never deleted). The learner's PROGRESS number
      // moves — facts.ts excludes archived content everywhere — and the
      // AWARD does not.
      await pool.query('update lessons set archived_at = now() where id = $1', [course.lessonIds[0]!]);

      expect(await countAwards(userId, badgeId)).toBe(1);
      expect(await countBadgeEvents(userId, badgeId)).toBe(1);
    });

    it('retuning the criteria out of reach leaves the award intact', async () => {
      const userId = await makeUser('retune');
      const course = await makeCourse('retune', 1);
      const badgeId = await makeBadge('retune', { type: 'lessons_completed', count: 1 }, 'admin');

      await completeLesson(userId, course.lessonIds[0]!);
      expect((await award(userId, 'lesson_completed')).badges.map((b) => b.slug)).toContain(badgeSlug('retune'));

      // The admin CRUD's edit path: a threshold raised well past what this
      // learner has done. Design §9.3 — editing criteria changes who will
      // earn it NEXT, never who has earned it.
      await pool.query(
        `update badges set criteria = $2::jsonb, updated_at = now() where id = $1`,
        [badgeId, JSON.stringify({ type: 'lessons_completed', count: 500 })],
      );

      expect(await countAwards(userId, badgeId)).toBe(1);
      const after = await award(userId, 'lesson_completed');
      expect(after.badges.map((b) => b.slug)).not.toContain(badgeSlug('retune'));
      expect(await countAwards(userId, badgeId)).toBe(1);
    });
  });
});
