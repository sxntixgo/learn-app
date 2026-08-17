import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import pg from 'pg';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runBackup } from './backup.ts';
import { runMigrations } from './migrate.ts';
import { parseConnectionString } from './pg-conn.ts';
import { isDatabaseEmpty, NotEmptyError, runRestore } from './restore.ts';

const { Pool } = pg;

const baseConnectionString = process.env.TEST_DATABASE_URL;
if (!baseConnectionString) {
  throw new Error('TEST_DATABASE_URL is not set — required to run restore.test.ts');
}

const parts = parseConnectionString(baseConnectionString);

/** Same server/credentials as TEST_DATABASE_URL, pointed at a different database. */
function urlFor(database: string): string {
  return `postgres://${encodeURIComponent(parts.user)}:${encodeURIComponent(parts.password)}@${parts.host}:${parts.port}/${database}`;
}

const adminConnectionString = urlFor('postgres');
const RUN_ID = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const SRC_DB = `learn_backup_test_src_${RUN_ID}`;
const DST_DB = `learn_backup_test_dst_${RUN_ID}`;
const DST_NONEMPTY_DB = `learn_backup_test_dstne_${RUN_ID}`;

async function createDatabase(name: string): Promise<void> {
  const pool = new Pool({ connectionString: adminConnectionString });
  try {
    await pool.query(`create database "${name}"`);
  } finally {
    await pool.end();
  }
}

async function dropDatabase(name: string): Promise<void> {
  const pool = new Pool({ connectionString: adminConnectionString });
  try {
    // `with (force)` disconnects any lingering sessions (e.g. a pool this
    // test forgot to end) rather than hanging or erroring on drop.
    await pool.query(`drop database if exists "${name}" with (force)`);
  } finally {
    await pool.end();
  }
}

interface Fixture {
  studentId: string;
  teacherId: string;
  courseId: string;
  lessonId: string;
}

/**
 * Populates representative data across the tables that matter for a
 * restore, per Phase 6b: users, courses, modules, lessons, lesson_progress,
 * activity_events, enrollments, user_roles.
 */
async function populate(pool: pg.Pool): Promise<Fixture> {
  const student = await pool.query<{ id: string }>(
    `insert into users (email, handle, display_name, avatar_kind, timezone)
     values ($1, $2, $3, $4, $5) returning id`,
    ['student@example.com', 'student-one', 'Student One', 'identicon', 'America/New_York'],
  );
  const studentId = student.rows[0]!.id;

  const teacher = await pool.query<{ id: string }>(
    `insert into users (email, handle, display_name, avatar_kind, timezone)
     values ($1, $2, $3, $4, $5) returning id`,
    ['teacher@example.com', 'teacher-one', 'Teacher One', 'identicon', 'UTC'],
  );
  const teacherId = teacher.rows[0]!.id;

  await pool.query(`insert into user_roles (user_id, role) values ($1, 'student')`, [studentId]);
  await pool.query(`insert into user_roles (user_id, role) values ($1, 'teacher')`, [teacherId]);

  const course = await pool.query<{ id: string }>(
    `insert into courses (slug, title, subtitle, description, tags, owner_id, visibility)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [
      `backup-test-course-${RUN_ID}`,
      'Backup Test Course',
      'A course used only to exercise backup/restore',
      'Description text with "quotes" and | pipes to stress the checksum.',
      ['alpha', 'beta'],
      teacherId,
      'open',
    ],
  );
  const courseId = course.rows[0]!.id;

  const mod = await pool.query<{ id: string }>(
    `insert into modules (course_id, key, title, position) values ($1, $2, $3, $4) returning id`,
    [courseId, 'mod-1', 'Module One', 0],
  );
  const moduleId = mod.rows[0]!.id;

  const lesson = await pool.query<{ id: string }>(
    `insert into lessons (course_id, module_id, lesson_key, slug, title, kind, source_path, content_hash, blocks)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [
      courseId,
      moduleId,
      'lesson-1',
      'lesson-1',
      'Lesson One',
      'lesson',
      'lesson-1.md',
      'hash-1',
      JSON.stringify([{ type: 'text', text: 'hello' }]),
    ],
  );
  const lessonId = lesson.rows[0]!.id;

  await pool.query(
    `insert into lesson_progress (user_id, lesson_id, state, completed_at, last_position, seconds_spent)
     values ($1, $2, 'complete', now(), 'block-3', 120)`,
    [studentId, lessonId],
  );

  await pool.query(`insert into enrollments (user_id, course_id, status) values ($1, $2, 'active')`, [
    studentId,
    courseId,
  ]);

  await pool.query(
    `insert into activity_events (user_id, type, course_id, lesson_id, meta)
     values ($1, 'lesson_completed', $2, $3, $4)`,
    [studentId, courseId, lessonId, JSON.stringify({ seconds_spent: 120 })],
  );
  await pool.query(
    `insert into activity_events (user_id, type, course_id, meta) values ($1, 'course_enrolled', $2, $3)`,
    [studentId, courseId, JSON.stringify({})],
  );

  return { studentId, teacherId, courseId, lessonId };
}

/** SQL expression for a timestamptz column that is timezone-independent (epoch seconds). */
function epoch(column: string): string {
  return `extract(epoch from ${column})`;
}

// Meaningful columns per table (Phase 6b's list plus `courses`/`modules`,
// which `lessons` depends on). Every value is wrapped in coalesce(...,'∅')
// before hashing so a NULL doesn't collapse the whole row into NULL.
const TABLE_COLUMNS: Record<string, string[]> = {
  users: ['id', 'email', 'handle', 'display_name', 'avatar_kind', 'timezone', epoch('created_at')],
  courses: ['id', 'slug', 'title', 'subtitle', 'description', 'tags', 'owner_id', 'visibility'],
  modules: ['id', 'course_id', 'key', 'title', 'position'],
  lessons: [
    'id',
    'course_id',
    'module_id',
    'lesson_key',
    'slug',
    'title',
    'kind',
    'source_path',
    'content_hash',
    'blocks',
  ],
  lesson_progress: ['user_id', 'lesson_id', 'state', epoch('completed_at'), 'last_position', 'seconds_spent'],
  activity_events: ['id', 'user_id', 'type', 'course_id', 'lesson_id', 'meta', epoch('occurred_at')],
  enrollments: ['id', 'user_id', 'course_id', 'status', epoch('enrolled_at')],
  user_roles: ['user_id', 'role', epoch('granted_at'), 'granted_by'],
};

interface TableSnapshot {
  count: number;
  checksum: string;
}

/**
 * An order-independent content checksum for one table: hash each row's
 * meaningful columns, then hash the sorted set of row hashes. Order-
 * independent because a restored table's physical row order is not
 * guaranteed to match the source's; sensitive to content because it is a
 * hash of the actual column values, not just a row count.
 */
async function tableSnapshot(pool: pg.Pool, table: string, columns: string[]): Promise<TableSnapshot> {
  const rowExpr = columns.map((c) => `coalesce((${c})::text, '∅')`).join(` || '|' || `);
  const { rows } = await pool.query<{ count: string; checksum: string }>(
    `select count(*)::text as count,
            coalesce(md5(string_agg(row_hash, '' order by row_hash)), '') as checksum
     from (select md5(${rowExpr}) as row_hash from ${table}) t`,
  );
  return { count: Number(rows[0]!.count), checksum: rows[0]!.checksum };
}

async function snapshotAll(pool: pg.Pool): Promise<Record<string, TableSnapshot>> {
  const result: Record<string, TableSnapshot> = {};
  for (const [table, columns] of Object.entries(TABLE_COLUMNS)) {
    result[table] = await tableSnapshot(pool, table, columns);
  }
  return result;
}

describe.sequential('backup + restore', () => {
  let srcPool: pg.Pool;
  let dstPool: pg.Pool;
  let scratchDir: string;
  let dumpFile: string;
  let fixture: Fixture;

  beforeAll(async () => {
    await createDatabase(SRC_DB);
    await createDatabase(DST_DB);
    await createDatabase(DST_NONEMPTY_DB);

    srcPool = new Pool({ connectionString: urlFor(SRC_DB) });
    dstPool = new Pool({ connectionString: urlFor(DST_DB) });

    await runMigrations(urlFor(SRC_DB));
    fixture = await populate(srcPool);

    scratchDir = await mkdtemp(path.join(os.tmpdir(), 'learn-backup-'));
  }, 60_000);

  afterAll(async () => {
    await srcPool?.end();
    await dstPool?.end();
    await dropDatabase(SRC_DB);
    await dropDatabase(DST_DB);
    await dropDatabase(DST_NONEMPTY_DB);
    if (scratchDir) await rm(scratchDir, { recursive: true, force: true });
  }, 60_000);

  it('backs up the populated database to a custom-format dump', async () => {
    const result = await runBackup(urlFor(SRC_DB), { outDir: scratchDir, keep: 7 });

    expect(existsSync(result.file)).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
    dumpFile = result.file;
  }, 60_000);

  it('restores into a fresh, empty database and matches row counts and content checksums', async () => {
    expect(await isDatabaseEmpty(urlFor(DST_DB))).toBe(true);

    await runRestore(dumpFile, urlFor(DST_DB));

    const [srcSnapshot, dstSnapshot] = await Promise.all([snapshotAll(srcPool), snapshotAll(dstPool)]);

    for (const table of Object.keys(TABLE_COLUMNS)) {
      expect(dstSnapshot[table]!.count, `${table} row count`).toBeGreaterThan(0);
      expect(dstSnapshot[table]!.count, `${table} row count`).toBe(srcSnapshot[table]!.count);
      expect(dstSnapshot[table]!.checksum, `${table} content checksum`).toBe(srcSnapshot[table]!.checksum);
    }
  }, 60_000);

  it('preserves the activity_events append-only trigger across the restore', async () => {
    const { rows } = await dstPool.query<{ id: string }>('select id from activity_events limit 1');
    const id = rows[0]!.id;

    await expect(dstPool.query(`update activity_events set meta = '{}'::jsonb where id = $1`, [id])).rejects.toThrow(
      /append-only/,
    );
    await expect(dstPool.query(`delete from activity_events where id = $1`, [id])).rejects.toThrow(/append-only/);
  });

  it('preserves the user_roles admin-exclusivity constraint across the restore', async () => {
    // fixture.studentId already holds 'student' in the restored database;
    // granting 'admin' alongside it must still be rejected by the exclusion
    // constraint, not silently accepted because the restore dropped it.
    await expect(
      dstPool.query(`insert into user_roles (user_id, role) values ($1, 'admin')`, [fixture.studentId]),
    ).rejects.toMatchObject({ code: '23P01' /* exclusion_violation */ });
  });

  it('refuses to restore over a non-empty database without --force, and touches nothing', async () => {
    await runMigrations(urlFor(DST_NONEMPTY_DB));
    expect(await isDatabaseEmpty(urlFor(DST_NONEMPTY_DB))).toBe(false);

    await expect(runRestore(dumpFile, urlFor(DST_NONEMPTY_DB))).rejects.toThrow(NotEmptyError);

    const pool = new Pool({ connectionString: urlFor(DST_NONEMPTY_DB) });
    try {
      const { rows } = await pool.query<{ n: string }>('select count(*)::text as n from courses');
      expect(rows[0]!.n).toBe('0'); // migrated schema only — the refused restore wrote nothing
    } finally {
      await pool.end();
    }
  }, 60_000);

  it('restores over a non-empty database when --force is given', async () => {
    await runRestore(dumpFile, urlFor(DST_NONEMPTY_DB), { force: true });

    const pool = new Pool({ connectionString: urlFor(DST_NONEMPTY_DB) });
    try {
      const snapshot = await tableSnapshot(pool, 'courses', TABLE_COLUMNS.courses!);
      expect(snapshot.count).toBeGreaterThan(0);
    } finally {
      await pool.end();
    }
  }, 60_000);
});
