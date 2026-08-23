import { describe, it, expect, afterAll } from 'vitest';
import { readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { runMigrations } from './migrate.ts';

const { Pool } = pg;

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is not set — required to run migrate.test.ts');
}

const pool = new Pool({ connectionString });

// Explicitly resolve the migrations directory
const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../db/migrations',
);

// Tables created across all migrations, dependents-first so a plain DROP
// (no CASCADE needed, but harmless) always succeeds regardless of FK order.
const ALL_TABLES = ['import_runs', 'lessons', 'modules', 'tracks', 'courses', 'content_repos', 'schema_migrations'];

async function resetDatabase() {
  // Course invites (migration 0005) reference `courses`, and 0005 re-adds
  // that FK on every re-run precisely BECAUSE this function drops `courses`
  // with CASCADE while leaving `invites` in place. A course invite left
  // behind by an interrupted test file therefore makes the repair fail with
  // "violates foreign key constraint invites_course_id_fkey", and every test
  // in this file goes red for a reason that has nothing to do with
  // migrations — which is exactly what happened while Phase 13 was being
  // built, and cost an hour. A row pointing at a table we are about to drop
  // is debris by definition, so it goes first.
  const invites = await pool.query<{ exists: string | null }>(`select to_regclass('public.invites')::text as exists`);
  if (invites.rows[0]?.exists) {
    await pool.query('DELETE FROM invites WHERE course_id IS NOT NULL');
  }

  // Drop everything the migrations might create so each run starts from empty,
  // letting this test suite run repeatedly against the same test database.
  for (const table of ALL_TABLES) {
    await pool.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
  }
}

/**
 * How many migrations there are on disk. Counted rather than hard-coded so
 * adding a migration does not silently make "was everything applied?" a
 * weaker assertion than it looks.
 */
async function countMigrationFiles(): Promise<number> {
  const files = await readdir(migrationsDir);
  return files.filter((f) => f.endsWith('.sql')).length;
}

/** Creates a bare course + module pair, used as FK targets by the constraint tests below. */
async function createCourseAndModule(): Promise<{ courseId: string; moduleId: string }> {
  const course = await pool.query<{ id: string }>(
    `insert into courses (slug, title) values ($1, $2) returning id`,
    [`constraint-test-course-${Date.now()}-${Math.random()}`, 'Constraint Test Course'],
  );
  const courseId = course.rows[0]!.id;
  const module = await pool.query<{ id: string }>(
    `insert into modules (course_id, key, title) values ($1, $2, $3) returning id`,
    [courseId, 'mod-1', 'Module One'],
  );
  return { courseId, moduleId: module.rows[0]!.id };
}

describe('migrate', () => {
  afterAll(async () => {
    // Reset, then PUT THE SCHEMA BACK. This suite shares one database with
    // every other DB-touching test file, and vitest runs them sequentially
    // (`fileParallelism: false`, CLAUDE.md). Dropping `courses`, `lessons`,
    // `modules` and the rest and then leaving is fine for THIS file — every
    // test here calls resetDatabase() first — but it hands the next file an
    // empty schema.
    //
    // Most files apply their own migrations and survive it. The ones that
    // rely on CI's `npm run migrate` step do not, and they fail with
    // `relation "courses" does not exist` for reasons that have nothing to
    // do with what they test. That is order-dependent, so it stays hidden
    // until an unrelated new test file reshuffles the order — which is
    // exactly how it surfaced.
    //
    // Leaving the database as we found it is the fix that does not depend
    // on all ~40 other files remembering to defend themselves.
    await resetDatabase();
    await runMigrations(connectionString, migrationsDir);
    await pool.end();
  });

  it('applies every migration from empty and records each version', async () => {
    await resetDatabase();

    const result = await runMigrations(connectionString!, migrationsDir);

    expect(result.applied).toContain('0001_lessons');
    expect(result.applied).toContain('0002_content_schema');
    expect(result.applied).toContain('0003_import_bookkeeping');

    for (const table of ['lessons', 'content_repos', 'courses', 'tracks', 'modules', 'import_runs']) {
      const found = await pool.query(
        `select table_name from information_schema.tables where table_schema = 'public' and table_name = $1`,
        [table],
      );
      expect(found.rowCount, `expected table "${table}" to exist`).toBe(1);
    }

    const migrations = await pool.query('select version from schema_migrations');
    expect(migrations.rowCount).toBe(await countMigrationFiles());
  });

  it('is a no-op the second time and schema_migrations has one row per migration file', async () => {
    await resetDatabase();

    await runMigrations(connectionString!);
    const second = await runMigrations(connectionString!);

    expect(second.applied).toEqual([]);

    const migrations = await pool.query('select version from schema_migrations');
    expect(migrations.rowCount).toBe(await countMigrationFiles());
  });

  describe('0002_content_schema constraints', () => {
    it('rejects a track hue outside the five-hue palette', async () => {
      await resetDatabase();
      await runMigrations(connectionString!);
      const { courseId } = await createCourseAndModule();

      await expect(
        pool.query(`insert into tracks (course_id, key, name, hue) values ($1, $2, $3, $4)`, [
          courseId,
          'bad-track',
          'Bad Track',
          'purple',
        ]),
      ).rejects.toMatchObject({ code: '23514' /* check_violation */ });
    });

    it('accepts every valid hue', async () => {
      await resetDatabase();
      await runMigrations(connectionString!);
      const { courseId } = await createCourseAndModule();

      for (const hue of ['blue', 'teal', 'ochre', 'maroon', 'slate']) {
        await expect(
          pool.query(`insert into tracks (course_id, key, name, hue) values ($1, $2, $3, $4)`, [
            courseId,
            `track-${hue}`,
            hue,
            hue,
          ]),
        ).resolves.toBeTruthy();
      }
    });

    it('rejects a lesson kind outside lesson|exercise|quiz', async () => {
      await resetDatabase();
      await runMigrations(connectionString!);
      const { courseId, moduleId } = await createCourseAndModule();

      await expect(
        pool.query(
          `insert into lessons (course_id, module_id, lesson_key, slug, title, kind, source_path, content_hash, blocks)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [courseId, moduleId, 'l1', 'l1', 'Lesson One', 'essay', 'l1.md', 'hash1', '[]'],
        ),
      ).rejects.toMatchObject({ code: '23514' /* check_violation */ });
    });

    it('rejects a duplicate (module_id, lesson_key) — the lesson-identity unique constraint', async () => {
      await resetDatabase();
      await runMigrations(connectionString!);
      const { courseId, moduleId } = await createCourseAndModule();

      await pool.query(
        `insert into lessons (course_id, module_id, lesson_key, slug, title, source_path, content_hash, blocks)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [courseId, moduleId, 'dup-key', 'dup-key', 'First', 'dup.md', 'hash1', '[]'],
      );

      await expect(
        pool.query(
          `insert into lessons (course_id, module_id, lesson_key, slug, title, source_path, content_hash, blocks)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [courseId, moduleId, 'dup-key', 'dup-key-2', 'Second', 'dup2.md', 'hash2', '[]'],
        ),
      ).rejects.toMatchObject({ code: '23505' /* unique_violation */ });
    });
  });

  // ===========================================================================
  // 0007_course_ownership — design §5: "course ownership scopes a teacher's
  // authority". The policy module (api/src/policy/can.ts) reads
  // `courses.owner_id` for every "own courses" cell of the §5 matrix, so the
  // column's nullability and its delete behaviour ARE authorization
  // behaviour, not schema trivia.
  // ===========================================================================
  describe('0007_course_ownership', () => {
    /** A throwaway users row to own a course with. */
    async function createUser(label: string): Promise<string> {
      const { rows } = await pool.query<{ id: string }>(
        `insert into users (display_name) values ($1) returning id`,
        [`${label}-${Date.now()}-${Math.random()}`],
      );
      return rows[0]!.id;
    }

    it('gives courses a nullable owner_id: an imported course starts unowned', async () => {
      await resetDatabase();
      await runMigrations(connectionString!);
      const { courseId } = await createCourseAndModule();

      const { rows } = await pool.query<{ owner_id: string | null }>('select owner_id from courses where id = $1', [
        courseId,
      ]);
      expect(rows[0]!.owner_id).toBeNull();
    });

    it('refuses an owner_id that is not a real user', async () => {
      await resetDatabase();
      await runMigrations(connectionString!);
      const { courseId } = await createCourseAndModule();

      await expect(
        pool.query('update courses set owner_id = $2 where id = $1', [
          courseId,
          '00000000-0000-0000-0000-0000000000ff',
        ]),
      ).rejects.toMatchObject({ code: '23503' /* foreign_key_violation */ });
    });

    it('un-owns the course when its owner is deleted — never deletes the course', async () => {
      await resetDatabase();
      await runMigrations(connectionString!);
      const { courseId } = await createCourseAndModule();
      const ownerId = await createUser('course-owner');

      await pool.query('update courses set owner_id = $2 where id = $1', [courseId, ownerId]);
      await pool.query('delete from users where id = $1', [ownerId]);

      const { rows } = await pool.query<{ owner_id: string | null }>('select owner_id from courses where id = $1', [
        courseId,
      ]);
      expect(rows).toHaveLength(1);
      // Now unowned, which can() reads as "admin only" — a deleted teacher
      // must not leave their courses editable by whoever gets the next uuid.
      expect(rows[0]!.owner_id).toBeNull();
    });
  });
});
