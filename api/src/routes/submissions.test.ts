import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { buildServer } from '../index.ts';
import { setPool, closePool } from '../db.ts';
import { DEV_ACTOR, type Actor } from '../policy/can.ts';
import { importCourse } from '../content/import.ts';
import { loadCourse } from '../content/manifest.ts';

// =============================================================================
// EXERCISE SUBMISSIONS — and above all, THE SNAPSHOT INVARIANT (design §9.4):
//
//   "Submissions snapshot the block content as presented, and annotations
//    anchor to the snapshot — never to the live lesson. Otherwise an
//    annotation on 'line 14' silently corrupts the moment that lesson is
//    edited, and every past submission rots."
//
// The centrepiece here is `THE CRITICAL TEST` below, which does the real
// thing rather than a mock of it: it imports a course with the REAL importer,
// submits an exercise with annotations on specific lines, EDITS THE SOURCE
// MARKDOWN, RE-IMPORTS IT with the same importer, and then asserts both
// halves — that the lesson row genuinely changed, and that the submission did
// not. A test that only asserted the second half would pass against an
// importer that silently did nothing.
// =============================================================================

const { Pool } = pg;

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is not set — required to run submissions.test.ts');
}

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '../../../db/migrations');

const pool = new Pool({ connectionString });

// Mirrors quiz.test.ts / progress.test.ts — each DB-touching test file owns
// its migration bootstrap; no shared util exists in this codebase yet.
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
// Fixtures: real content repos on disk, imported by the real importer.
// ---------------------------------------------------------------------------

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const COURSE_SLUG = `submission-test-course-${RUN_ID}`;
const SNAPSHOT_COURSE_SLUG = `snapshot-invariant-course-${RUN_ID}`;

// Two more courses of their own, because both of the suites that use them
// assert "and nothing was written" — which is only meaningful on a lesson no
// earlier test has already left a submission on. `exercise_submissions` is
// unique on (user_id, lesson_id), so sharing one would make the assertion
// read a row somebody else created.
const SHAPE_SLUG = `shape-refusal-course-${RUN_ID}`;
const ROLLBACK_SLUG = `rollback-course-${RUN_ID}`;

const EXERCISE_SLUG = 'exercises-ex01';
const PLAIN_SLUG = 'exercises-plain';

/**
 * A NUL byte — the cheapest string Postgres will not store in a `text`
 * column (SQLSTATE 22021). JSON carries it happily as a unicode escape, so
 * it is a value that passes every check a route makes on the way in and is
 * refused only by the database — which is what makes it the right probe for
 * the `catch { ROLLBACK; throw }` arms.
 */
const NUL = String.fromCharCode(0);

/** The code the student reviews, BEFORE the upstream edit. Line numbers matter. */
const ORIGINAL_CODE = [
  'def review(diff):',
  '    findings = []',
  '    for hunk in diff.hunks:',
  '        findings += scan(hunk)',
  '    return findings',
].join('\n');

/**
 * The same file after an author edits it: three lines inserted at the top.
 * Every line the student annotated has MOVED — line 3 was
 * "for hunk in diff.hunks:" and is now "log = logging.getLogger(__name__)".
 * That shift is the whole point: an annotation re-anchored against this
 * version would be attached to code the student never commented on.
 */
const EDITED_CODE = [
  'import logging',
  '',
  'log = logging.getLogger(__name__)',
  '',
  'def review(diff):',
  '    findings = []',
  '    for hunk in diff.hunks:',
  '        findings += scan(hunk)',
  '    return findings',
].join('\n');

function exerciseMarkdown(title: string, code: string): string {
  return `---\ntitle: ${title}\nkind: exercise\n---\n\nReview this function.\n\n\`\`\`python\n${code}\n\`\`\`\n`;
}

/**
 * An exercise lesson carrying BOTH a code block (for annotations) and a
 * rubric block (design §9.4, Task A/C) — the fixture the grading tests
 * (Task B/C) score against.
 */
function exerciseWithRubricMarkdown(title: string, code: string, criteriaYaml: string): string {
  return (
    `---\ntitle: ${title}\nkind: exercise\n---\n\nReview this function.\n\n` +
    `\`\`\`python\n${code}\n\`\`\`\n\n\`\`\`rubric\ncriteria:\n${criteriaYaml}\n\`\`\`\n`
  );
}

interface LessonFixture {
  file: string;
  body: string;
}

async function writeCourseDir(
  dir: string,
  slug: string,
  lessons: LessonFixture[],
  tracks: Array<{ id: string; name: string; hue: string }> = [],
): Promise<string> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  const manifest = {
    schema: 1,
    slug,
    title: 'Submission Test Course',
    ...(tracks.length > 0 ? { tracks } : {}),
    modules: [{ id: 'exercises', title: 'Exercises', lessons: lessons.map((l) => l.file) }],
  };
  await writeFile(path.join(dir, 'course.yaml'), JSON.stringify(manifest, null, 2));

  for (const lesson of lessons) {
    const abs = path.join(dir, lesson.file);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, lesson.body);
  }
  return dir;
}

/** Loads and imports a course directory through the REAL importer, as the admin route does. */
async function importDir(dir: string): Promise<void> {
  const course = await loadCourse(dir);
  const client = await pool.connect();
  try {
    await importCourse(client, course);
  } finally {
    client.release();
  }
}

async function lessonRow(courseSlug: string, lessonSlug: string) {
  const { rows } = await pool.query<{ id: string; content_hash: string; blocks: unknown[]; updated_at: Date }>(
    `select l.id, l.content_hash, l.blocks, l.updated_at
       from lessons l join courses c on c.id = l.course_id
      where c.slug = $1 and l.slug = $2`,
    [courseSlug, lessonSlug],
  );
  return rows[0]!;
}

function codeSourceOf(blocks: unknown): string {
  const block = (blocks as Array<{ type: string; source?: string }>).find((b) => b.type === 'code');
  return block?.source ?? '';
}

// ---------------------------------------------------------------------------
// Actors. Two real `users` rows, because "a student cannot read another
// student's submission" needs a second student who actually exists.
// ---------------------------------------------------------------------------

let otherStudent: Actor;

interface SubmissionBody {
  id: string;
  lessonSlug: string;
  status: 'draft' | 'submitted' | 'returned';
  snapshot: Array<{ type: string; source?: string; html?: string; lang?: string | null }>;
  snapshotHash: string;
  annotations: Array<{
    id: string;
    blockIndex: number;
    startLine: number;
    endLine: number;
    body: string;
    track: string | null;
    parentId: string | null;
    authorId: string;
    createdAt: string;
  }>;
  submittedAt: string | null;
  returnedAt: string | null;
}

const submissionUrl = (courseSlug: string, lessonSlug: string) =>
  `/api/v1/courses/${courseSlug}/lessons/${lessonSlug}/submission`;

describe('exercise submissions', () => {
  let tmpRoot: string;

  beforeAll(async () => {
    await applyMigrations();
    setPool(pool);

    tmpRoot = await mkdtemp(path.join(tmpdir(), 'submission-test-'));

    // The general-purpose course: one exercise, one plain lesson.
    await importDir(
      await writeCourseDir(path.join(tmpRoot, 'course'), COURSE_SLUG, [
        { file: 'modules/exercises/ex01.md', body: exerciseMarkdown('Exercise One', ORIGINAL_CODE) },
        { file: 'modules/exercises/plain.md', body: '---\ntitle: Plain Lesson\n---\n\nJust prose.\n' },
      ]),
    );

    // One exercise each, for the two suites that assert a refused save wrote
    // nothing: they need a (user_id, lesson_id) no other test has touched.
    await importDir(
      await writeCourseDir(path.join(tmpRoot, 'shape-course'), SHAPE_SLUG, [
        { file: 'modules/exercises/ex01.md', body: exerciseMarkdown('Shape Refusals', ORIGINAL_CODE) },
      ]),
    );
    await importDir(
      await writeCourseDir(path.join(tmpRoot, 'rollback-course'), ROLLBACK_SLUG, [
        { file: 'modules/exercises/ex01.md', body: exerciseMarkdown('Rollback', ORIGINAL_CODE) },
      ]),
    );

    // Imported courses land `hidden` (migration 0008) and these tests are
    // about submissions, not visibility — the lesson-read gate is exercised
    // in courses.test.ts.
    await pool.query(`update courses set visibility = 'open' where slug in ($1, $2, $3, $4)`, [
      COURSE_SLUG,
      SNAPSHOT_COURSE_SLUG,
      SHAPE_SLUG,
      ROLLBACK_SLUG,
    ]);

    const user = await pool.query<{ id: string }>(
      `insert into users (display_name) values ('Other Student') returning id`,
    );
    otherStudent = { id: user.rows[0]!.id, roles: ['student'] };
  });

  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
    // Deliberately does NOT delete rows — see progress.test.ts's afterAll
    // (append-only activity_events, non-cascading FKs). The unique per-run
    // course slug is what keeps repeated runs from colliding.
    await closePool();
  });

  // ===========================================================================
  // THE CRITICAL TEST OF THIS PHASE.
  // ===========================================================================
  describe('THE SNAPSHOT INVARIANT: a submission survives an upstream edit and re-import', () => {
    it('keeps the exact snapshot, anchors, and line content the student submitted — while the lesson row itself does update', async () => {
      const dir = path.join(tmpRoot, 'snapshot-course');
      const lessonFile = 'modules/exercises/ex01.md';

      // --- 1. Import the course as the author first wrote it. ---------------
      await importDir(
        await writeCourseDir(dir, SNAPSHOT_COURSE_SLUG, [
          { file: lessonFile, body: exerciseMarkdown('Triage', ORIGINAL_CODE) },
        ]),
      );
      await pool.query(`update courses set visibility = 'open' where slug = $1`, [SNAPSHOT_COURSE_SLUG]);

      const before = await lessonRow(SNAPSHOT_COURSE_SLUG, EXERCISE_SLUG);
      expect(codeSourceOf(before.blocks)).toBe(ORIGINAL_CODE);

      // --- 2. The student annotates specific lines and submits. -------------
      const fastify = await buildServer({ actor: DEV_ACTOR });

      const draft = await fastify.inject({
        method: 'PUT',
        url: submissionUrl(SNAPSHOT_COURSE_SLUG, EXERCISE_SLUG),
        payload: {
          annotations: [
            // Lines 3-4: "for hunk in diff.hunks:" / "findings += scan(hunk)".
            { blockIndex: 1, startLine: 3, endLine: 4, body: 'This loop is the shallow-module smell.' },
            // Line 5: "return findings".
            { blockIndex: 1, startLine: 5, endLine: 5, body: 'Returns a mutable list the caller can corrupt.' },
          ],
        },
      });
      expect(draft.statusCode).toBe(200);

      const submitted = await fastify.inject({
        method: 'POST',
        url: `${submissionUrl(SNAPSHOT_COURSE_SLUG, EXERCISE_SLUG)}/submit`,
      });
      expect(submitted.statusCode).toBe(200);
      const asSubmitted = JSON.parse(submitted.payload) as SubmissionBody;
      expect(asSubmitted.status).toBe('submitted');

      // Exactly what the student saw, captured for a byte-for-byte
      // comparison after the edit.
      const snapshotAsSubmitted = JSON.stringify(asSubmitted.snapshot);
      const hashAsSubmitted = asSubmitted.snapshotHash;
      const anchorsAsSubmitted = asSubmitted.annotations.map((a) => ({
        blockIndex: a.blockIndex,
        startLine: a.startLine,
        endLine: a.endLine,
        body: a.body,
      }));
      expect(anchorsAsSubmitted).toHaveLength(2);

      // --- 3. The author edits the lesson upstream and re-imports it. -------
      // Three lines inserted at the top: every annotated line has moved.
      await writeCourseDir(dir, SNAPSHOT_COURSE_SLUG, [
        { file: lessonFile, body: exerciseMarkdown('Triage', EDITED_CODE) },
      ]);
      await importDir(dir);

      // --- 4a. The LESSON really did change. --------------------------------
      // Without this half, the assertions below would also pass against an
      // importer that silently skipped the re-import.
      const after = await lessonRow(SNAPSHOT_COURSE_SLUG, EXERCISE_SLUG);
      expect(codeSourceOf(after.blocks)).toBe(EDITED_CODE);
      expect(after.content_hash).not.toBe(before.content_hash);
      // ...on the SAME row. The stable lesson id is what makes the snapshot
      // rule meaningful: the submission still points at a real lesson.
      expect(after.id).toBe(before.id);

      // The live lesson's line 3 is now a completely different statement.
      const liveLines = codeSourceOf(after.blocks).split('\n');
      expect(liveLines[2]).toBe('log = logging.getLogger(__name__)');

      // --- 4b. The SUBMISSION did not. --------------------------------------
      const refetched = await fastify.inject({
        method: 'GET',
        url: submissionUrl(SNAPSHOT_COURSE_SLUG, EXERCISE_SLUG),
      });
      expect(refetched.statusCode).toBe(200);
      const now = JSON.parse(refetched.payload) as SubmissionBody;

      // Same snapshot, byte for byte.
      expect(JSON.stringify(now.snapshot)).toBe(snapshotAsSubmitted);
      expect(now.snapshotHash).toBe(hashAsSubmitted);
      // Same anchors.
      expect(
        now.annotations.map((a) => ({
          blockIndex: a.blockIndex,
          startLine: a.startLine,
          endLine: a.endLine,
          body: a.body,
        })),
      ).toEqual(anchorsAsSubmitted);
      // Same LINE CONTENT under those anchors — the assertion that actually
      // says "a teacher grading this sees what the student saw". Line 3 of
      // the snapshot is still the loop, not the logger.
      const snapshotLines = codeSourceOf(now.snapshot).split('\n');
      expect(snapshotLines[2]).toBe('    for hunk in diff.hunks:');
      expect(snapshotLines[3]).toBe('        findings += scan(hunk)');
      expect(snapshotLines[4]).toBe('    return findings');
      expect(codeSourceOf(now.snapshot)).toBe(ORIGINAL_CODE);
      // And the two really are different now — the snapshot is a copy, not a
      // window onto the lesson.
      expect(codeSourceOf(now.snapshot)).not.toBe(codeSourceOf(after.blocks));

      await fastify.close();
    });

    it('the database itself refuses to rewrite a snapshot — the rule is not just route discipline', async () => {
      const { rows } = await pool.query<{ id: string }>(
        `select s.id from exercise_submissions s
           join lessons l on l.id = s.lesson_id
           join courses c on c.id = l.course_id
          where c.slug = $1 and s.user_id = $2`,
        [SNAPSHOT_COURSE_SLUG, DEV_ACTOR.id],
      );
      const submissionId = rows[0]!.id;

      await expect(
        pool.query(`update exercise_submissions set snapshot = '[]'::jsonb where id = $1`, [submissionId]),
      ).rejects.toThrow(/frozen/i);

      // The status may still move — grading is an additive layer (§9.4).
      await expect(
        pool.query(`update exercise_submissions set updated_at = now() where id = $1`, [submissionId]),
      ).resolves.toBeTruthy();
    });

    it('a DRAFT snapshot is frozen too: re-importing mid-draft does not re-anchor work in progress', async () => {
      const dir = path.join(tmpRoot, 'draft-course');
      const slug = `draft-freeze-course-${RUN_ID}`;
      const lessonFile = 'modules/exercises/ex01.md';

      await importDir(
        await writeCourseDir(dir, slug, [{ file: lessonFile, body: exerciseMarkdown('Draft', ORIGINAL_CODE) }]),
      );
      await pool.query(`update courses set visibility = 'open' where slug = $1`, [slug]);

      const fastify = await buildServer({ actor: DEV_ACTOR });
      const saved = await fastify.inject({
        method: 'PUT',
        url: submissionUrl(slug, EXERCISE_SLUG),
        payload: { annotations: [{ blockIndex: 1, startLine: 3, endLine: 3, body: 'Still thinking about this.' }] },
      });
      expect(saved.statusCode).toBe(200);
      const draft = JSON.parse(saved.payload) as SubmissionBody;
      expect(draft.status).toBe('draft');

      await writeCourseDir(dir, slug, [{ file: lessonFile, body: exerciseMarkdown('Draft', EDITED_CODE) }]);
      await importDir(dir);

      const refetched = await fastify.inject({ method: 'GET', url: submissionUrl(slug, EXERCISE_SLUG) });
      const now = JSON.parse(refetched.payload) as SubmissionBody;
      expect(now.snapshotHash).toBe(draft.snapshotHash);
      expect(codeSourceOf(now.snapshot)).toBe(ORIGINAL_CODE);
      expect(now.annotations[0]!.startLine).toBe(3);

      // A second draft save does not re-take the snapshot from the (now
      // edited) lesson either. The snapshot is taken once, on first save.
      const resaved = await fastify.inject({
        method: 'PUT',
        url: submissionUrl(slug, EXERCISE_SLUG),
        payload: { annotations: [{ blockIndex: 1, startLine: 4, endLine: 4, body: 'Changed my mind.' }] },
      });
      expect(resaved.statusCode).toBe(200);
      const after = JSON.parse(resaved.payload) as SubmissionBody;
      expect(after.snapshotHash).toBe(draft.snapshotHash);
      expect(codeSourceOf(after.snapshot)).toBe(ORIGINAL_CODE);

      await fastify.close();
    });
  });

  // ===========================================================================
  // Submitting: completion, and exactly one event.
  // ===========================================================================
  describe('POST .../submission/submit', () => {
    it('completes the lesson on SUBMIT — a solo course with no grader can still finish (§9.1)', async () => {
      const fastify = await buildServer({ actor: DEV_ACTOR });

      const response = await fastify.inject({
        method: 'POST',
        url: `${submissionUrl(COURSE_SLUG, EXERCISE_SLUG)}/submit`,
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as SubmissionBody;
      expect(body.status).toBe('submitted');
      expect(body.submittedAt).not.toBeNull();
      // Nobody has graded it, and nobody has to.
      expect(body.returnedAt).toBeNull();

      const lesson = await lessonRow(COURSE_SLUG, EXERCISE_SLUG);
      const progress = await pool.query<{ state: string; completed_at: Date | null }>(
        `select state, completed_at from lesson_progress where user_id = $1 and lesson_id = $2`,
        [DEV_ACTOR.id, lesson.id],
      );
      expect(progress.rows[0]?.state).toBe('complete');
      expect(progress.rows[0]?.completed_at).not.toBeNull();

      await fastify.close();
    });

    it('submitting twice emits exactly one exercise_submitted event', async () => {
      const fastify = await buildServer({ actor: DEV_ACTOR });
      const lesson = await lessonRow(COURSE_SLUG, EXERCISE_SLUG);

      const before = await pool.query<{ c: number }>(
        `select count(*)::int as c from activity_events
          where user_id = $1 and lesson_id = $2 and type = 'exercise_submitted'`,
        [DEV_ACTOR.id, lesson.id],
      );
      // The submit above already ran once for this lesson.
      expect(before.rows[0]!.c).toBe(1);

      const again = await fastify.inject({
        method: 'POST',
        url: `${submissionUrl(COURSE_SLUG, EXERCISE_SLUG)}/submit`,
      });
      // Idempotent, not an error: a retried request must not lock a student
      // out of their own submission.
      expect(again.statusCode).toBe(200);
      expect((JSON.parse(again.payload) as SubmissionBody).status).toBe('submitted');

      const after = await pool.query<{ c: number }>(
        `select count(*)::int as c from activity_events
          where user_id = $1 and lesson_id = $2 and type = 'exercise_submitted'`,
        [DEV_ACTOR.id, lesson.id],
      );
      expect(after.rows[0]!.c).toBe(1);

      // ...and exactly one submission row, not a second attempt.
      const rows = await pool.query<{ c: number }>(
        `select count(*)::int as c from exercise_submissions where user_id = $1 and lesson_id = $2`,
        [DEV_ACTOR.id, lesson.id],
      );
      expect(rows.rows[0]!.c).toBe(1);

      await fastify.close();
    });

    it('refuses to submit a lesson that is not an exercise (§9.1: one rule per kind)', async () => {
      const fastify = await buildServer({ actor: DEV_ACTOR });
      const response = await fastify.inject({
        method: 'POST',
        url: `${submissionUrl(COURSE_SLUG, PLAIN_SLUG)}/submit`,
      });
      expect(response.statusCode).toBe(409);
      await fastify.close();
    });
  });

  // ===========================================================================
  // A returned submission is not overwritable by a new draft.
  // ===========================================================================
  describe('PUT .../submission (draft)', () => {
    it('a draft save against a RETURNED submission is refused, not silently applied', async () => {
      const dir = path.join(tmpRoot, 'returned-course');
      const slug = `returned-course-${RUN_ID}`;
      await importDir(
        await writeCourseDir(dir, slug, [
          { file: 'modules/exercises/ex01.md', body: exerciseMarkdown('Returned', ORIGINAL_CODE) },
        ]),
      );
      await pool.query(`update courses set visibility = 'open' where slug = $1`, [slug]);

      const fastify = await buildServer({ actor: DEV_ACTOR });

      await fastify.inject({
        method: 'PUT',
        url: submissionUrl(slug, EXERCISE_SLUG),
        payload: { annotations: [{ blockIndex: 1, startLine: 2, endLine: 2, body: 'My original review comment.' }] },
      });
      const submitted = await fastify.inject({ method: 'POST', url: `${submissionUrl(slug, EXERCISE_SLUG)}/submit` });
      const original = JSON.parse(submitted.payload) as SubmissionBody;

      // Phase 9 owns the return flow; this is the state it will leave behind.
      await pool.query(
        `update exercise_submissions set status = 'returned', returned_at = now() where id = $1`,
        [original.id],
      );

      const overwrite = await fastify.inject({
        method: 'PUT',
        url: submissionUrl(slug, EXERCISE_SLUG),
        payload: { annotations: [{ blockIndex: 1, startLine: 5, endLine: 5, body: 'Sneaky rewrite after grading.' }] },
      });
      expect(overwrite.statusCode).toBe(409);
      expect((JSON.parse(overwrite.payload) as { message: string }).message).toMatch(/returned/i);

      // Nothing moved.
      const refetched = await fastify.inject({ method: 'GET', url: submissionUrl(slug, EXERCISE_SLUG) });
      const now = JSON.parse(refetched.payload) as SubmissionBody;
      expect(now.status).toBe('returned');
      expect(now.annotations).toHaveLength(1);
      expect(now.annotations[0]!.body).toBe('My original review comment.');
      expect(now.annotations[0]!.startLine).toBe(2);

      await fastify.close();
    });

    it('a draft save against a SUBMITTED submission is refused too — handing in freezes it', async () => {
      const fastify = await buildServer({ actor: DEV_ACTOR });
      const response = await fastify.inject({
        method: 'PUT',
        url: submissionUrl(COURSE_SLUG, EXERCISE_SLUG),
        payload: { annotations: [{ blockIndex: 1, startLine: 1, endLine: 1, body: 'Too late.' }] },
      });
      expect(response.statusCode).toBe(409);
      await fastify.close();
    });

    it('creates the submission on first save, freezing the snapshot from the CURRENT lesson blocks', async () => {
      const dir = path.join(tmpRoot, 'first-save-course');
      const slug = `first-save-course-${RUN_ID}`;
      await importDir(
        await writeCourseDir(dir, slug, [
          { file: 'modules/exercises/ex01.md', body: exerciseMarkdown('First Save', ORIGINAL_CODE) },
        ]),
      );
      await pool.query(`update courses set visibility = 'open' where slug = $1`, [slug]);

      const fastify = await buildServer({ actor: DEV_ACTOR });
      const response = await fastify.inject({
        method: 'PUT',
        url: submissionUrl(slug, EXERCISE_SLUG),
        payload: { annotations: [{ blockIndex: 1, startLine: 1, endLine: 2, body: 'Signature and setup.' }] },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as SubmissionBody;
      expect(body.status).toBe('draft');
      expect(body.submittedAt).toBeNull();
      expect(body.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
      // The snapshot is the whole presented block array, not just the code.
      expect(body.snapshot.map((b) => b.type)).toEqual(['prose', 'code']);
      expect(codeSourceOf(body.snapshot)).toBe(ORIGINAL_CODE);
      expect(body.annotations).toHaveLength(1);
      expect(body.annotations[0]).toMatchObject({ blockIndex: 1, startLine: 1, endLine: 2, parentId: null });
      expect(body.annotations[0]!.authorId).toBe(DEV_ACTOR.id);

      // Saving again REPLACES the set — a draft is the current state of the
      // student's work, not an append log.
      const resaved = await fastify.inject({
        method: 'PUT',
        url: submissionUrl(slug, EXERCISE_SLUG),
        payload: {
          annotations: [
            { blockIndex: 1, startLine: 1, endLine: 2, body: 'Signature and setup.' },
            { blockIndex: 1, startLine: 4, endLine: 4, body: 'Mutating a list in a loop.', track: 'cx' },
          ],
        },
      });
      expect(resaved.statusCode).toBe(200);
      const after = JSON.parse(resaved.payload) as SubmissionBody;
      expect(after.annotations).toHaveLength(2);
      expect(after.annotations[1]!.track).toBe('cx');
      expect(after.id).toBe(body.id);

      await fastify.close();
    });

    it('refuses an anchor that does not land in the snapshot rather than clamping it', async () => {
      const dir = path.join(tmpRoot, 'anchor-course');
      const slug = `anchor-course-${RUN_ID}`;
      await importDir(
        await writeCourseDir(dir, slug, [
          { file: 'modules/exercises/ex01.md', body: exerciseMarkdown('Anchors', ORIGINAL_CODE) },
        ]),
      );
      await pool.query(`update courses set visibility = 'open' where slug = $1`, [slug]);

      const fastify = await buildServer({ actor: DEV_ACTOR });

      // Past the end of a 5-line block.
      const tooFar = await fastify.inject({
        method: 'PUT',
        url: submissionUrl(slug, EXERCISE_SLUG),
        payload: { annotations: [{ blockIndex: 1, startLine: 6, endLine: 6, body: 'Nowhere.' }] },
      });
      expect(tooFar.statusCode).toBe(400);

      // A block that is not code (index 0 is the prose block).
      const notCode = await fastify.inject({
        method: 'PUT',
        url: submissionUrl(slug, EXERCISE_SLUG),
        payload: { annotations: [{ blockIndex: 0, startLine: 1, endLine: 1, body: 'Prose has no lines.' }] },
      });
      expect(notCode.statusCode).toBe(400);

      // Inverted range.
      const inverted = await fastify.inject({
        method: 'PUT',
        url: submissionUrl(slug, EXERCISE_SLUG),
        payload: { annotations: [{ blockIndex: 1, startLine: 4, endLine: 2, body: 'Backwards.' }] },
      });
      expect(inverted.statusCode).toBe(400);

      // Empty body.
      const empty = await fastify.inject({
        method: 'PUT',
        url: submissionUrl(slug, EXERCISE_SLUG),
        payload: { annotations: [{ blockIndex: 1, startLine: 1, endLine: 1, body: '   ' }] },
      });
      expect(empty.statusCode).toBe(400);

      // Not an array at all.
      const malformed = await fastify.inject({
        method: 'PUT',
        url: submissionUrl(slug, EXERCISE_SLUG),
        payload: { annotations: 'nope' },
      });
      expect(malformed.statusCode).toBe(400);

      // Nothing was written by any of those.
      const refetched = await fastify.inject({ method: 'GET', url: submissionUrl(slug, EXERCISE_SLUG) });
      expect(refetched.statusCode).toBe(404);

      await fastify.close();
    });

    it('refuses a draft on a lesson that is not an exercise', async () => {
      const fastify = await buildServer({ actor: DEV_ACTOR });
      const response = await fastify.inject({
        method: 'PUT',
        url: submissionUrl(COURSE_SLUG, PLAIN_SLUG),
        payload: { annotations: [] },
      });
      expect(response.statusCode).toBe(409);
      await fastify.close();
    });

    // -----------------------------------------------------------------------
    // SHAPE VALIDATION, before any database work at all.
    //
    // `inputError` runs on the raw body and returns ONE message per problem;
    // its whole reason for existing is that a malformed annotation must not
    // reach `anchorError` (which reads the snapshot) or the INSERT (which
    // would then be the thing that decides what "valid" means). The anchor
    // test above covers the cases that need a snapshot to judge; these are
    // the ones that are wrong on their face.
    //
    // Each case is asserted on its MESSAGE as well as its status, because
    // "400" alone cannot tell a caller which of five annotations it got
    // wrong — and the wrong index in that message is the failure a person
    // debugging a save actually hits.
    // -----------------------------------------------------------------------
    it('refuses a body whose annotations are the wrong shape, naming the offending index', async () => {
      const fastify = await buildServer({ actor: DEV_ACTOR });

      const cases: Array<{ what: string; annotations: unknown; expect: RegExp }> = [
        {
          what: 'more annotations than a code review could plausibly carry',
          // 501: one past MAX_ANNOTATIONS. A submission is a code review,
          // not a data store, and the ceiling is what keeps one request from
          // becoming 500 INSERTs.
          annotations: Array.from({ length: 501 }, () => ({
            blockIndex: 1,
            startLine: 1,
            endLine: 1,
            body: 'Fine on its own.',
          })),
          expect: /at most 500 annotations/,
        },
        {
          what: 'an element that is not an object',
          annotations: [{ blockIndex: 1, startLine: 1, endLine: 1, body: 'Fine.' }, null],
          expect: /annotations\[1\] must be an object/,
        },
        {
          what: 'a blockIndex that is not a non-negative integer',
          annotations: [{ blockIndex: -1, startLine: 1, endLine: 1, body: 'Negative block.' }],
          expect: /annotations\[0\]\.blockIndex/,
        },
        {
          what: 'a startLine below 1 — anchors are 1-indexed, not 0-indexed',
          annotations: [{ blockIndex: 1, startLine: 0, endLine: 1, body: 'Zeroth line.' }],
          expect: /annotations\[0\]\.startLine/,
        },
        {
          what: 'an endLine that is not an integer',
          annotations: [{ blockIndex: 1, startLine: 1, endLine: 2.5, body: 'Half a line.' }],
          expect: /annotations\[0\]\.endLine/,
        },
        {
          what: 'a body past the length ceiling',
          annotations: [{ blockIndex: 1, startLine: 1, endLine: 1, body: 'x'.repeat(10_001) }],
          expect: /exceeds 10000 characters/,
        },
        {
          what: 'a track that is present but blank',
          // Present-but-blank is refused rather than normalized to null: a
          // caller that sent "" meant to send something.
          annotations: [{ blockIndex: 1, startLine: 1, endLine: 1, body: 'Fine.', track: '   ' }],
          expect: /annotations\[0\]\.track/,
        },
      ];

      for (const testCase of cases) {
        const response = await fastify.inject({
          method: 'PUT',
          url: submissionUrl(SHAPE_SLUG, EXERCISE_SLUG),
          payload: { annotations: testCase.annotations },
        });
        expect(response.statusCode, testCase.what).toBe(400);
        expect((JSON.parse(response.payload) as { message: string }).message, testCase.what).toMatch(testCase.expect);
      }

      // Not one of them created a submission row. This is the half that
      // matters: `inputError` runs BEFORE the transaction opens, so a
      // rejected first save must leave nothing behind for a later, valid
      // save to inherit.
      const refetched = await fastify.inject({ method: 'GET', url: submissionUrl(SHAPE_SLUG, EXERCISE_SLUG) });
      expect(refetched.statusCode).toBe(404);

      await fastify.close();
    });

    // A NUL byte is the cheapest way to make Postgres refuse a `text`
    // parameter (SQLSTATE 22021, "invalid byte sequence for encoding UTF8")
    // from inside the transaction rather than before it: it survives JSON,
    // survives `inputError` (it is a non-empty string of legal length) and
    // survives `anchorError` (it says nothing about anchors), so the first
    // thing that objects is the INSERT in `replaceAnnotations`.
    //
    // That is exactly the situation the `catch { ROLLBACK; throw }` arm
    // exists for, and the thing it protects is stated in the route: a
    // rejected first save "leaves no half-started submission behind". Without
    // the rollback the exercise_submissions row created moments earlier in
    // the same transaction would still be committed by the pool's next
    // COMMIT, and the student would own a submission with a snapshot they
    // never chose.
    it('rolls the whole draft save back when the database refuses a write mid-transaction', async () => {
      const fastify = await buildServer({ actor: DEV_ACTOR });

      const response = await fastify.inject({
        method: 'PUT',
        url: submissionUrl(ROLLBACK_SLUG, EXERCISE_SLUG),
        payload: {
          annotations: [{ blockIndex: 1, startLine: 1, endLine: 1, body: `Contains a NUL:${NUL}here.` }],
        },
      });
      expect(response.statusCode).toBe(500);

      // The submission that would have been created is not there — neither
      // through the route nor in the table itself.
      const refetched = await fastify.inject({ method: 'GET', url: submissionUrl(ROLLBACK_SLUG, EXERCISE_SLUG) });
      expect(refetched.statusCode).toBe(404);

      const rows = await pool.query<{ c: number }>(
        `select count(*)::int as c
           from exercise_submissions es
           join lessons l on l.id = es.lesson_id
           join courses c on c.id = l.course_id
          where c.slug = $1 and es.user_id = $2`,
        [ROLLBACK_SLUG, DEV_ACTOR.id],
      );
      expect(rows.rows[0]!.c).toBe(0);

      // And the connection went back to the pool usable. Without the
      // ROLLBACK it would be handed on still inside an aborted transaction,
      // and the next request to draw it would fail with 25P02 for reasons
      // that have nothing to do with what it asked for.
      const afterwards = await fastify.inject({
        method: 'PUT',
        url: submissionUrl(ROLLBACK_SLUG, EXERCISE_SLUG),
        payload: { annotations: [{ blockIndex: 1, startLine: 1, endLine: 1, body: 'A perfectly ordinary note.' }] },
      });
      expect(afterwards.statusCode).toBe(200);

      await fastify.close();
    });
  });

  // ===========================================================================
  // Visibility: the route half of Gate 9.
  // ===========================================================================
  describe('GET .../submission', () => {
    it('a student cannot read another student’s submission', async () => {
      // DEV_ACTOR has a submitted submission on this lesson, with annotation
      // bodies that would be unmistakable in a response body.
      const mine = await buildServer({ actor: DEV_ACTOR });
      const theirs = await buildServer({ actor: otherStudent });

      const own = await mine.inject({ method: 'GET', url: submissionUrl(SNAPSHOT_COURSE_SLUG, EXERCISE_SLUG) });
      expect(own.statusCode).toBe(200);
      expect(own.payload).toContain('shallow-module smell');

      // The other student sees their OWN (nonexistent) submission for the
      // same lesson — never the first student's. There is no request shape
      // that names another user at all: the query is keyed on the actor.
      const other = await theirs.inject({ method: 'GET', url: submissionUrl(SNAPSHOT_COURSE_SLUG, EXERCISE_SLUG) });
      expect(other.statusCode).toBe(404);
      expect(other.payload).not.toContain('shallow-module smell');

      // And they cannot reach it by submitting over it either: their submit
      // creates a submission of their own.
      const theirSubmit = await theirs.inject({
        method: 'POST',
        url: `${submissionUrl(SNAPSHOT_COURSE_SLUG, EXERCISE_SLUG)}/submit`,
      });
      expect(theirSubmit.statusCode).toBe(200);
      const theirBody = JSON.parse(theirSubmit.payload) as SubmissionBody;
      expect(theirBody.annotations).toEqual([]);

      const stillMine = await mine.inject({ method: 'GET', url: submissionUrl(SNAPSHOT_COURSE_SLUG, EXERCISE_SLUG) });
      const mineBody = JSON.parse(stillMine.payload) as SubmissionBody;
      expect(mineBody.annotations).toHaveLength(2);
      expect(mineBody.id).not.toBe(theirBody.id);

      await mine.close();
      await theirs.close();
    });

    it('404s when the actor has no submission for this lesson', async () => {
      const fastify = await buildServer({ actor: otherStudent });
      const response = await fastify.inject({ method: 'GET', url: submissionUrl(COURSE_SLUG, PLAIN_SLUG) });
      expect(response.statusCode).toBe(404);
      await fastify.close();
    });

    it('404s for an unknown course or lesson slug', async () => {
      const fastify = await buildServer({ actor: DEV_ACTOR });
      expect(
        (await fastify.inject({ method: 'GET', url: submissionUrl('no-such-course-xyz', EXERCISE_SLUG) })).statusCode,
      ).toBe(404);
      expect(
        (await fastify.inject({ method: 'GET', url: submissionUrl(COURSE_SLUG, 'no-such-lesson-xyz') })).statusCode,
      ).toBe(404);
      await fastify.close();
    });
  });

  // ===========================================================================
  // The policy seam (CLAUDE.md rule 2).
  // ===========================================================================
  describe('the can() seam', () => {
    it('asks can() with the right action and the actor as the subject, on all three routes', async () => {
      const canSpy = vi.fn().mockReturnValue(true);
      const fastify = await buildServer({ can: canSpy, actor: DEV_ACTOR });

      await fastify.inject({ method: 'GET', url: submissionUrl(COURSE_SLUG, EXERCISE_SLUG) });
      await fastify.inject({
        method: 'PUT',
        url: submissionUrl(COURSE_SLUG, EXERCISE_SLUG),
        payload: { annotations: [] },
      });
      await fastify.inject({ method: 'POST', url: `${submissionUrl(COURSE_SLUG, EXERCISE_SLUG)}/submit` });

      const calls = canSpy.mock.calls as Array<[unknown, string, { userId?: string }]>;
      expect(calls.map((c) => c[1])).toEqual([
        'lesson:exercise:read',
        'lesson:exercise:save',
        'lesson:exercise:submit',
      ]);
      for (const call of calls) {
        // The subject is always the actor's own id — a route that omitted it
        // would be denied by can() (policy/can.ts, property 2).
        expect(call[2].userId).toBe(DEV_ACTOR.id);
      }

      await fastify.close();
    });

    it('403s on every route when the policy denies', async () => {
      const fastify = await buildServer({ can: () => false, actor: DEV_ACTOR });
      expect((await fastify.inject({ method: 'GET', url: submissionUrl(COURSE_SLUG, EXERCISE_SLUG) })).statusCode).toBe(
        403,
      );
      expect(
        (
          await fastify.inject({
            method: 'PUT',
            url: submissionUrl(COURSE_SLUG, EXERCISE_SLUG),
            payload: { annotations: [] },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (await fastify.inject({ method: 'POST', url: `${submissionUrl(COURSE_SLUG, EXERCISE_SLUG)}/submit` }))
          .statusCode,
      ).toBe(403);
      await fastify.close();
    });
  });

  // ===========================================================================
  // GRADING (design §9.4, Task B/C): the teacher's half of this module.
  //
  // `exercise_submissions` is `unique (user_id, lesson_id)` — one submission
  // per student per exercise, ever (migration 0011: "there is no retake
  // row"). So every test below that needs an untouched submission creates
  // its OWN student, via `freshSubmission()`, rather than sharing one across
  // tests the way the describe block's `owner`/`otherTeacher` are shared —
  // those are read-only actors here, but a student here is mutated by the
  // very thing under test.
  // ===========================================================================
  describe('grading: POST .../submissions/{userId}/grade and GET .../submissions/{userId}', () => {
    const RUBRIC_SLUG = `rubric-course-${RUN_ID}`;
    const RUBRIC_EXERCISE_SLUG = 'exercises-ex01';
    const NO_RUBRIC_EXERCISE_SLUG = 'exercises-plain-ex';
    /** A kind:"lesson" lesson in the SAME owned course, so `wrongKind` can be reached past the policy gate. */
    const PROSE_LESSON_SLUG = 'exercises-prose';
    /**
     * A lesson written straight into the table, carrying a rubric block whose
     * `criteria` is not a list. Nothing in the authoring path can produce it
     * (schemas/blocks.schema.json would refuse it on import), which is
     * precisely why `rubricCriteriaOf` is written defensively — and why the
     * only way to test that defence is to put the shape there by hand.
     */
    const MALFORMED_RUBRIC_SLUG = 'malformed-rubric';

    let owner: Actor;
    let otherTeacher: Actor;

    const gradeUrl = (userId: string) =>
      `/api/v1/courses/${RUBRIC_SLUG}/lessons/${RUBRIC_EXERCISE_SLUG}/submissions/${userId}/grade`;
    const teacherViewUrl = (userId: string) =>
      `/api/v1/courses/${RUBRIC_SLUG}/lessons/${RUBRIC_EXERCISE_SLUG}/submissions/${userId}`;

    beforeAll(async () => {
      const dir = path.join(tmpRoot, 'rubric-course');
      await importDir(
        await writeCourseDir(
          dir,
          RUBRIC_SLUG,
          [
            {
              file: 'modules/exercises/ex01.md',
              body: exerciseWithRubricMarkdown(
                'Rubric Exercise',
                ORIGINAL_CODE,
                '  - name: Spotted the shallow module\n    max: 5\n    track: cx\n  - name: Review tone\n    max: 3',
              ),
            },
            { file: 'modules/exercises/plain-ex.md', body: exerciseMarkdown('No Rubric', ORIGINAL_CODE) },
            { file: 'modules/exercises/prose.md', body: '---\ntitle: Prose Lesson\n---\n\nNothing to hand in.\n' },
          ],
          [{ id: 'cx', name: 'Complexity', hue: 'blue' }],
        ),
      );
      await pool.query(`update courses set visibility = 'open' where slug = $1`, [RUBRIC_SLUG]);

      // The hand-written lesson described above. It reuses the imported
      // course's own module so it is a live lesson by the same rule every
      // other lesson-scoped route applies (`findLiveLesson`).
      const rubricCourse = await pool.query<{ id: string }>('select id from courses where slug = $1', [RUBRIC_SLUG]);
      const rubricModule = await pool.query<{ id: string }>(
        'select id from modules where course_id = $1 order by position limit 1',
        [rubricCourse.rows[0]!.id],
      );
      await pool.query(
        `insert into lessons
           (course_id, module_id, lesson_key, slug, title, kind, position, source_path, content_hash, blocks)
         values ($1, $2, 'malformed-rubric', $3, 'Malformed Rubric', 'exercise', 90, 'malformed.md', $4, $5::jsonb)`,
        [
          rubricCourse.rows[0]!.id,
          rubricModule.rows[0]!.id,
          MALFORMED_RUBRIC_SLUG,
          `malformed-${RUN_ID}`,
          JSON.stringify([
            { type: 'prose', html: '<p>Review this.</p>' },
            { type: 'code', lang: 'python', source: ORIGINAL_CODE },
            // `criteria` is a string, not a list of criteria.
            { type: 'rubric', criteria: 'five points for effort' },
          ]),
        ],
      );

      const ownerRow = await pool.query<{ id: string }>(
        `insert into users (display_name) values ('Rubric Owner') returning id`,
      );
      owner = { id: ownerRow.rows[0]!.id, roles: ['teacher'] };
      await pool.query(`update courses set owner_id = $2 where slug = $1`, [RUBRIC_SLUG, owner.id]);

      const otherRow = await pool.query<{ id: string }>(
        `insert into users (display_name) values ('Other Teacher') returning id`,
      );
      otherTeacher = { id: otherRow.rows[0]!.id, roles: ['teacher'] };
    });

    /** A brand-new student, so each test gets an untouched (user_id, lesson_id) row. */
    async function newStudent(displayName: string): Promise<Actor> {
      const row = await pool.query<{ id: string }>(`insert into users (display_name) values ($1) returning id`, [
        displayName,
      ]);
      return { id: row.rows[0]!.id, roles: ['student'] };
    }

    /** Creates a fresh student, submits one annotation for them, and returns both. */
    async function freshSubmission(): Promise<{ student: Actor; submission: SubmissionBody }> {
      const student = await newStudent('Grading Student');
      const fastify = await buildServer({ actor: student });
      await fastify.inject({
        method: 'PUT',
        url: submissionUrl(RUBRIC_SLUG, RUBRIC_EXERCISE_SLUG),
        payload: {
          annotations: [{ blockIndex: 1, startLine: 3, endLine: 4, body: 'The loop building this list.' }],
        },
      });
      const submitted = await fastify.inject({
        method: 'POST',
        url: `${submissionUrl(RUBRIC_SLUG, RUBRIC_EXERCISE_SLUG)}/submit`,
      });
      await fastify.close();
      return { student, submission: JSON.parse(submitted.payload) as SubmissionBody };
    }

    it('a teacher who does not own the course is refused — 403 on both the read and the grade route', async () => {
      const { student, submission } = await freshSubmission();
      const outsider = await buildServer({ actor: otherTeacher });

      const read = await outsider.inject({ method: 'GET', url: teacherViewUrl(student.id) });
      expect(read.statusCode).toBe(403);

      const grade = await outsider.inject({
        method: 'POST',
        url: gradeUrl(student.id),
        payload: {
          rubricScores: [
            { criterion: 'Spotted the shallow module', points: 5 },
            { criterion: 'Review tone', points: 3 },
          ],
        },
      });
      expect(grade.statusCode).toBe(403);

      // Confirms the refusal actually stopped the write, not just the response code.
      const refetch = await pool.query<{ status: string }>(
        `select status from exercise_submissions where id = $1`,
        [submission.id],
      );
      expect(refetch.rows[0]!.status).toBe('submitted');
      await outsider.close();
    });

    it('the owning teacher scores every criterion and adds a reply and a top-level annotation in one call', async () => {
      const { student, submission } = await freshSubmission();
      const teacher = await buildServer({ actor: owner });

      const studentAnnotationId = submission.annotations[0]!.id;

      const graded = await teacher.inject({
        method: 'POST',
        url: gradeUrl(student.id),
        payload: {
          rubricScores: [
            { criterion: 'Spotted the shallow module', points: 4 },
            { criterion: 'Review tone', points: 2 },
          ],
          annotations: [
            { parentId: studentAnnotationId, body: 'Good catch — this is exactly the shallow-module smell.' },
            { blockIndex: 1, startLine: 5, endLine: 5, body: 'You missed this: a mutable return value.' },
          ],
        },
      });
      expect(graded.statusCode).toBe(200);
      const body = JSON.parse(graded.payload) as SubmissionBody & {
        rubricScores: Array<{ criterion: string; points: number; max: number; track: string | null; scoredBy: string }>;
      };

      expect(body.status).toBe('returned');
      expect(body.returnedAt).not.toBeNull();

      expect(body.rubricScores).toHaveLength(2);
      const byName = new Map(body.rubricScores.map((s) => [s.criterion, s]));
      expect(byName.get('Spotted the shallow module')).toMatchObject({ points: 4, max: 5, track: 'cx' });
      expect(byName.get('Review tone')).toMatchObject({ points: 2, max: 3, track: null });
      expect(byName.get('Spotted the shallow module')!.scoredBy).toBe(owner.id);

      expect(body.annotations).toHaveLength(3);
      const reply = body.annotations.find((a) => a.parentId === studentAnnotationId);
      expect(reply).toBeDefined();
      expect(reply!.authorId).toBe(owner.id);
      // The reply INHERITS the parent's anchor rather than trusting a
      // resupplied one — the parent was blockIndex 1, lines 3-4.
      expect(reply!.blockIndex).toBe(1);
      expect(reply!.startLine).toBe(3);
      expect(reply!.endLine).toBe(4);

      const topLevel = body.annotations.find((a) => a.authorId === owner.id && a.parentId === null);
      expect(topLevel).toBeDefined();
      expect(topLevel!.startLine).toBe(5);

      // Exactly one exercise_returned event, owned by the STUDENT.
      const events = await pool.query<{ c: number }>(
        `select count(*)::int as c from activity_events
          where user_id = $1 and type = 'exercise_returned' and meta->>'submissionId' = $2`,
        [student.id, submission.id],
      );
      expect(events.rows[0]!.c).toBe(1);

      // The student sees their score and feedback through their own GET.
      const studentServer = await buildServer({ actor: student });
      const selfView = await studentServer.inject({
        method: 'GET',
        url: submissionUrl(RUBRIC_SLUG, RUBRIC_EXERCISE_SLUG),
      });
      const selfBody = JSON.parse(selfView.payload) as SubmissionBody & {
        rubricScores: Array<{ criterion: string; points: number }>;
      };
      expect(selfBody.status).toBe('returned');
      expect(selfBody.rubricScores).toHaveLength(2);
      expect(selfBody.annotations).toHaveLength(3);
      await studentServer.close();

      await teacher.close();
    });

    it('re-grading updates a criterion and never deletes an annotation — and emits no second event', async () => {
      const { student, submission } = await freshSubmission();
      const teacher = await buildServer({ actor: owner });

      const first = await teacher.inject({
        method: 'POST',
        url: gradeUrl(student.id),
        payload: {
          rubricScores: [
            { criterion: 'Spotted the shallow module', points: 3 },
            { criterion: 'Review tone', points: 1 },
          ],
          annotations: [{ blockIndex: 1, startLine: 1, endLine: 1, body: 'First pass note.' }],
        },
      });
      const firstBody = JSON.parse(first.payload) as SubmissionBody;
      expect(firstBody.annotations).toHaveLength(2);
      const returnedAtFirst = firstBody.returnedAt;

      const second = await teacher.inject({
        method: 'POST',
        url: gradeUrl(student.id),
        payload: {
          rubricScores: [
            // Corrects the earlier score.
            { criterion: 'Spotted the shallow module', points: 5 },
            { criterion: 'Review tone', points: 1 },
          ],
          annotations: [{ blockIndex: 1, startLine: 2, endLine: 2, body: 'Second pass note.' }],
        },
      });
      expect(second.statusCode).toBe(200);
      const secondBody = JSON.parse(second.payload) as SubmissionBody & {
        rubricScores: Array<{ criterion: string; points: number }>;
      };

      // returnedAt did not move — the student's "feedback arrived" moment is
      // the first grade call, not every re-grade.
      expect(secondBody.returnedAt).toBe(returnedAtFirst);

      // The score was corrected in place, not duplicated.
      expect(secondBody.rubricScores).toHaveLength(2);
      expect(secondBody.rubricScores.find((s) => s.criterion === 'Spotted the shallow module')!.points).toBe(5);

      // BOTH the student's original annotation AND the first grading pass's
      // annotation are still there — a re-grade only ever adds.
      expect(secondBody.annotations).toHaveLength(3);
      const bodies = secondBody.annotations.map((a) => a.body);
      expect(bodies).toContain('The loop building this list.');
      expect(bodies).toContain('First pass note.');
      expect(bodies).toContain('Second pass note.');

      // Exactly one event despite two grade calls.
      const events = await pool.query<{ c: number }>(
        `select count(*)::int as c from activity_events
          where user_id = $1 and type = 'exercise_returned' and meta->>'submissionId' = $2`,
        [student.id, submission.id],
      );
      expect(events.rows[0]!.c).toBe(1);

      await teacher.close();
    });

    it('threading is one level: a reply to a reply is refused', async () => {
      const { student, submission } = await freshSubmission();
      const teacher = await buildServer({ actor: owner });
      const studentAnnotationId = submission.annotations[0]!.id;

      const graded = await teacher.inject({
        method: 'POST',
        url: gradeUrl(student.id),
        payload: {
          rubricScores: [
            { criterion: 'Spotted the shallow module', points: 1 },
            { criterion: 'Review tone', points: 1 },
          ],
          annotations: [{ parentId: studentAnnotationId, body: 'A reply to the student.' }],
        },
      });
      const gradedBody = JSON.parse(graded.payload) as SubmissionBody;
      const replyId = gradedBody.annotations.find((a) => a.parentId === studentAnnotationId)!.id;

      const secondReply = await teacher.inject({
        method: 'POST',
        url: gradeUrl(student.id),
        payload: {
          rubricScores: [
            { criterion: 'Spotted the shallow module', points: 1 },
            { criterion: 'Review tone', points: 1 },
          ],
          annotations: [{ parentId: replyId, body: 'A reply to a reply.' }],
        },
      });
      expect(secondReply.statusCode).toBe(400);
      expect((JSON.parse(secondReply.payload) as { message: string }).message).toMatch(/one level/i);

      await teacher.close();
    });

    it('a reply cannot cross submissions — structurally impossible, not just refused by convention', async () => {
      // Two DIFFERENT students, each with their own submission.
      const { submission: submissionA } = await freshSubmission();

      const secondStudent = await newStudent('Second Grading Student');
      const studentB = await buildServer({ actor: secondStudent });
      await studentB.inject({
        method: 'PUT',
        url: submissionUrl(RUBRIC_SLUG, RUBRIC_EXERCISE_SLUG),
        payload: { annotations: [{ blockIndex: 1, startLine: 1, endLine: 1, body: "B's own comment." }] },
      });
      await studentB.inject({ method: 'POST', url: `${submissionUrl(RUBRIC_SLUG, RUBRIC_EXERCISE_SLUG)}/submit` });
      await studentB.close();

      const teacher = await buildServer({ actor: owner });
      // Attempts to reply to student A's annotation while grading student B.
      const crossSubmissionReply = await teacher.inject({
        method: 'POST',
        url: gradeUrl(secondStudent.id),
        payload: {
          rubricScores: [
            { criterion: 'Spotted the shallow module', points: 1 },
            { criterion: 'Review tone', points: 1 },
          ],
          annotations: [{ parentId: submissionA.annotations[0]!.id, body: 'Wrong submission.' }],
        },
      });
      expect(crossSubmissionReply.statusCode).toBe(400);

      await teacher.close();
    });

    it('rubricScores must cover every declared criterion exactly once', async () => {
      const { student } = await freshSubmission();
      const teacher = await buildServer({ actor: owner });

      const missing = await teacher.inject({
        method: 'POST',
        url: gradeUrl(student.id),
        payload: { rubricScores: [{ criterion: 'Spotted the shallow module', points: 1 }] },
      });
      expect(missing.statusCode).toBe(400);
      expect((JSON.parse(missing.payload) as { message: string }).message).toMatch(/Review tone/);

      const unknown = await teacher.inject({
        method: 'POST',
        url: gradeUrl(student.id),
        payload: {
          rubricScores: [
            { criterion: 'Spotted the shallow module', points: 1 },
            { criterion: 'Review tone', points: 1 },
            { criterion: 'Not a real criterion', points: 1 },
          ],
        },
      });
      expect(unknown.statusCode).toBe(400);

      const tooManyPoints = await teacher.inject({
        method: 'POST',
        url: gradeUrl(student.id),
        payload: {
          rubricScores: [
            { criterion: 'Spotted the shallow module', points: 999 },
            { criterion: 'Review tone', points: 1 },
          ],
        },
      });
      expect(tooManyPoints.statusCode).toBe(400);

      await teacher.close();
    });

    it('refuses rubricScores on an exercise with no rubric block declared', async () => {
      const student = await newStudent('No Rubric Student');
      const studentServer = await buildServer({ actor: student });
      await studentServer.inject({
        method: 'POST',
        url: `${submissionUrl(RUBRIC_SLUG, NO_RUBRIC_EXERCISE_SLUG)}/submit`,
      });
      await studentServer.close();

      const teacher = await buildServer({ actor: owner });
      const response = await teacher.inject({
        method: 'POST',
        url: `/api/v1/courses/${RUBRIC_SLUG}/lessons/${NO_RUBRIC_EXERCISE_SLUG}/submissions/${student.id}/grade`,
        payload: { rubricScores: [{ criterion: 'Anything', points: 1 }] },
      });
      expect(response.statusCode).toBe(400);

      // No rubric, no scores, still gradeable with annotations/return alone.
      const returnOnly = await teacher.inject({
        method: 'POST',
        url: `/api/v1/courses/${RUBRIC_SLUG}/lessons/${NO_RUBRIC_EXERCISE_SLUG}/submissions/${student.id}/grade`,
        payload: {},
      });
      expect(returnOnly.statusCode).toBe(200);
      expect((JSON.parse(returnOnly.payload) as SubmissionBody).status).toBe('returned');

      await teacher.close();
    });

    it('refuses to grade a submission that is still a draft', async () => {
      const student = await newStudent('Draft Only Student');
      const studentServer = await buildServer({ actor: student });
      await studentServer.inject({
        method: 'PUT',
        url: submissionUrl(RUBRIC_SLUG, RUBRIC_EXERCISE_SLUG),
        payload: { annotations: [] },
      });
      await studentServer.close();

      const teacher = await buildServer({ actor: owner });
      const response = await teacher.inject({
        method: 'POST',
        url: gradeUrl(student.id),
        payload: {
          rubricScores: [
            { criterion: 'Spotted the shallow module', points: 1 },
            { criterion: 'Review tone', points: 1 },
          ],
        },
      });
      expect(response.statusCode).toBe(409);
      await teacher.close();
    });

    it('404s when this student has no submission for the lesson', async () => {
      const student = await newStudent('Never Submitted');
      const teacher = await buildServer({ actor: owner });
      const response = await teacher.inject({
        method: 'POST',
        url: gradeUrl(student.id),
        payload: {},
      });
      expect(response.statusCode).toBe(404);
      await teacher.close();
    });

    it('the can() seam: asks for submission:grade, and rubric:score only when rubricScores is non-empty', async () => {
      const { student } = await freshSubmission();
      const canSpy = vi.fn().mockReturnValue(true);
      const teacher = await buildServer({ can: canSpy, actor: owner });

      await teacher.inject({ method: 'GET', url: teacherViewUrl(student.id) });
      await teacher.inject({
        method: 'POST',
        url: gradeUrl(student.id),
        payload: {
          rubricScores: [
            { criterion: 'Spotted the shallow module', points: 1 },
            { criterion: 'Review tone', points: 1 },
          ],
        },
      });

      const calls = canSpy.mock.calls as Array<[unknown, string, unknown]>;
      const actions = calls.map((c) => c[1]);
      expect(actions).toContain('submission:grade');
      expect(actions).toContain('rubric:score');

      await teacher.close();
    });

    // -------------------------------------------------------------------------
    // SHAPE VALIDATION ON THE GRADE BODY.
    //
    // A grade call carries two independent lists and both are checked before
    // the transaction opens. The refusals below are the ones a caller can
    // reach without a snapshot: "this is not the shape of a score" and "this
    // is not the shape of an annotation". The semantic ones — a criterion
    // that is not declared, an anchor that does not land — need the
    // submission and are covered separately.
    // -------------------------------------------------------------------------
    it('refuses a rubricScores list of the wrong shape, naming the offending index', async () => {
      const { student, submission } = await freshSubmission();
      const teacher = await buildServer({ actor: owner });

      const cases: Array<{ what: string; rubricScores: unknown; expect: RegExp }> = [
        { what: 'not a list at all', rubricScores: { criterion: 'x', points: 1 }, expect: /must be an array/ },
        { what: 'an element that is not an object', rubricScores: ['Review tone'], expect: /rubricScores\[0\] must be an object/ },
        {
          what: 'a blank criterion name',
          rubricScores: [{ criterion: '   ', points: 1 }],
          expect: /rubricScores\[0\]\.criterion/,
        },
        {
          what: 'points that are not a number',
          rubricScores: [{ criterion: 'Review tone', points: '3' }],
          expect: /rubricScores\[0\]\.points/,
        },
        {
          what: 'negative points',
          rubricScores: [{ criterion: 'Review tone', points: -1 }],
          expect: /rubricScores\[0\]\.points/,
        },
      ];

      for (const testCase of cases) {
        const response = await teacher.inject({
          method: 'POST',
          url: gradeUrl(student.id),
          payload: { rubricScores: testCase.rubricScores },
        });
        expect(response.statusCode, testCase.what).toBe(400);
        expect((JSON.parse(response.payload) as { message: string }).message, testCase.what).toMatch(testCase.expect);
      }

      // A refused grade call is not a partial grade call: the submission is
      // still awaiting review, not 'returned'.
      const after = await pool.query<{ status: string }>('select status from exercise_submissions where id = $1', [
        submission.id,
      ]);
      expect(after.rows[0]!.status).toBe('submitted');

      await teacher.close();
    });

    it('refuses a grade annotation of the wrong shape — and a reply that tries to bring its own anchor', async () => {
      const { student, submission } = await freshSubmission();
      const teacher = await buildServer({ actor: owner });
      const parentId = submission.annotations[0]!.id;

      const cases: Array<{ what: string; annotations: unknown; expect: RegExp }> = [
        { what: 'not a list at all', annotations: 'a note', expect: /must be an array/ },
        {
          what: 'more annotations than one grade call may add',
          annotations: Array.from({ length: 501 }, () => ({ blockIndex: 1, startLine: 1, endLine: 1, body: 'Note.' })),
          expect: /at most 500 annotations/,
        },
        { what: 'an element that is not an object', annotations: [null], expect: /annotations\[0\] must be an object/ },
        {
          what: 'a parentId that is not a usable string',
          annotations: [{ parentId: 42, body: 'Reply.' }],
          expect: /annotations\[0\]\.parentId/,
        },
        {
          // The heart of Task B: an anchor sent alongside parentId is
          // REFUSED, not quietly discarded. A caller that believed it chose
          // where its reply landed must be told it did not.
          what: 'a reply that also sends an anchor',
          annotations: [{ parentId, blockIndex: 1, startLine: 1, endLine: 1, body: 'Reply with an anchor.' }],
          expect: /derived/,
        },
        {
          what: 'a top-level annotation with no blockIndex',
          annotations: [{ startLine: 1, endLine: 1, body: 'Anchored nowhere.' }],
          expect: /required on a top-level annotation/,
        },
        {
          what: 'a startLine below 1',
          annotations: [{ blockIndex: 1, startLine: 0, endLine: 1, body: 'Zeroth line.' }],
          expect: /annotations\[0\]\.startLine/,
        },
        {
          what: 'an endLine below 1',
          annotations: [{ blockIndex: 1, startLine: 1, endLine: 0, body: 'Zeroth line.' }],
          expect: /annotations\[0\]\.endLine/,
        },
        {
          what: 'a range the caller got backwards',
          annotations: [{ blockIndex: 1, startLine: 4, endLine: 2, body: 'Backwards.' }],
          expect: /is before startLine/,
        },
        {
          what: 'a blank body',
          annotations: [{ blockIndex: 1, startLine: 1, endLine: 1, body: '   ' }],
          expect: /annotations\[0\]\.body must be a non-empty string/,
        },
        {
          what: 'a body past the length ceiling',
          annotations: [{ blockIndex: 1, startLine: 1, endLine: 1, body: 'x'.repeat(10_001) }],
          expect: /exceeds 10000 characters/,
        },
        {
          what: 'a track that is present but blank',
          annotations: [{ blockIndex: 1, startLine: 1, endLine: 1, body: 'Fine.', track: '' }],
          expect: /annotations\[0\]\.track/,
        },
      ];

      for (const testCase of cases) {
        const response = await teacher.inject({
          method: 'POST',
          url: gradeUrl(student.id),
          payload: { annotations: testCase.annotations },
        });
        expect(response.statusCode, testCase.what).toBe(400);
        expect((JSON.parse(response.payload) as { message: string }).message, testCase.what).toMatch(testCase.expect);
      }

      // Not one of them added an annotation, and none of them returned the
      // submission: shape validation runs before the transaction opens.
      const stored = await pool.query<{ c: number }>(
        'select count(*)::int as c from annotations where submission_id = $1',
        [submission.id],
      );
      expect(stored.rows[0]!.c).toBe(1);
      const after = await pool.query<{ status: string }>('select status from exercise_submissions where id = $1', [
        submission.id,
      ]);
      expect(after.rows[0]!.status).toBe('submitted');

      await teacher.close();
    });

    it('refuses the same criterion scored twice in one request', async () => {
      const { student, submission } = await freshSubmission();
      const teacher = await buildServer({ actor: owner });

      // Both entries name a REAL criterion, so this is not the "unknown
      // criterion" refusal wearing a different hat: the question is which of
      // the two scores would have won, and the answer is that neither does.
      const response = await teacher.inject({
        method: 'POST',
        url: gradeUrl(student.id),
        payload: {
          rubricScores: [
            { criterion: 'Review tone', points: 1 },
            { criterion: 'Review tone', points: 3 },
          ],
        },
      });
      expect(response.statusCode).toBe(400);
      expect((JSON.parse(response.payload) as { message: string }).message).toMatch(/scored twice/);

      const scores = await pool.query<{ c: number }>(
        'select count(*)::int as c from rubric_scores where submission_id = $1',
        [submission.id],
      );
      expect(scores.rows[0]!.c).toBe(0);

      await teacher.close();
    });

    it('asks for rubric:score separately, and refuses the whole call when only that half is denied', async () => {
      const { student, submission } = await freshSubmission();
      // MATRIX carries `submission:grade` and `rubric:score` as two cells so
      // an instance can hand scoring to a TA without handing over grading.
      // The route must therefore refuse on the narrower one alone — if it
      // only ever asked `submission:grade`, that split would be decoration.
      const teacher = await buildServer({
        can: (_actor, action) => action !== 'rubric:score',
        actor: owner,
      });

      const response = await teacher.inject({
        method: 'POST',
        url: gradeUrl(student.id),
        payload: {
          rubricScores: [
            { criterion: 'Spotted the shallow module', points: 4 },
            { criterion: 'Review tone', points: 2 },
          ],
          annotations: [{ blockIndex: 1, startLine: 1, endLine: 1, body: 'Would have been feedback.' }],
        },
      });
      expect(response.statusCode).toBe(403);

      // The refusal took the annotations and the return with it: a grade
      // call is one operation, not a best-effort partial one.
      const after = await pool.query<{ status: string }>('select status from exercise_submissions where id = $1', [
        submission.id,
      ]);
      expect(after.rows[0]!.status).toBe('submitted');
      const scores = await pool.query<{ c: number }>(
        'select count(*)::int as c from rubric_scores where submission_id = $1',
        [submission.id],
      );
      expect(scores.rows[0]!.c).toBe(0);

      await teacher.close();
    });

    it('refuses to grade a lesson that is not an exercise (§9.1: one rule per kind)', async () => {
      const teacher = await buildServer({ actor: owner });
      const student = await newStudent('Prose Lesson Student');

      const response = await teacher.inject({
        method: 'POST',
        url: `/api/v1/courses/${RUBRIC_SLUG}/lessons/${PROSE_LESSON_SLUG}/submissions/${student.id}/grade`,
        payload: {},
      });
      // 409, not 404: the lesson is right there, the caller is at the wrong
      // endpoint for it — the same status progress.ts and quiz.ts use for
      // the mirror-image mistake.
      expect(response.statusCode).toBe(409);
      expect((JSON.parse(response.payload) as { message: string }).message).toMatch(/kind "lesson"/);

      await teacher.close();
    });

    it('404s the teacher’s read of a student who never started the exercise', async () => {
      const teacher = await buildServer({ actor: owner });
      const student = await newStudent('Teacher Read Nothing');

      const response = await teacher.inject({ method: 'GET', url: teacherViewUrl(student.id) });
      expect(response.statusCode).toBe(404);
      // Named by lesson, not by student: the message must not become a
      // report on whether that account exists.
      expect((JSON.parse(response.payload) as { message: string }).message).toMatch(/No submission from this student/);

      await teacher.close();
    });

    it('refuses a teacher annotation anchored outside the snapshot, and keeps the scores out too', async () => {
      const { student, submission } = await freshSubmission();
      const teacher = await buildServer({ actor: owner });

      const response = await teacher.inject({
        method: 'POST',
        url: gradeUrl(student.id),
        payload: {
          rubricScores: [
            { criterion: 'Spotted the shallow module', points: 5 },
            { criterion: 'Review tone', points: 3 },
          ],
          // The code block in this snapshot is five lines long.
          annotations: [{ blockIndex: 1, startLine: 40, endLine: 41, body: 'A line the student never read.' }],
        },
      });
      expect(response.statusCode).toBe(400);

      // The anchor check runs INSIDE the transaction, after the submission
      // is locked — so the thing being asserted here is the ROLLBACK: a
      // teacher whose annotation was refused has not silently scored the
      // rubric or returned the work.
      const after = await pool.query<{ status: string }>('select status from exercise_submissions where id = $1', [
        submission.id,
      ]);
      expect(after.rows[0]!.status).toBe('submitted');
      const scores = await pool.query<{ c: number }>(
        'select count(*)::int as c from rubric_scores where submission_id = $1',
        [submission.id],
      );
      expect(scores.rows[0]!.c).toBe(0);

      await teacher.close();
    });

    it('reads a rubric block it does not recognise as NO rubric, rather than failing the request', async () => {
      // `snapshot` comes off jsonb as `unknown`, so `rubricCriteriaOf` is
      // written to shrug at a shape it does not understand. The alternative
      // — throwing — would turn one malformed block into a 500 on every
      // attempt to grade that submission, with no way for a teacher to get
      // past it.
      const student = await newStudent('Malformed Rubric Student');
      const studentServer = await buildServer({ actor: student });
      await studentServer.inject({
        method: 'POST',
        url: `${submissionUrl(RUBRIC_SLUG, MALFORMED_RUBRIC_SLUG)}/submit`,
      });
      await studentServer.close();

      const teacher = await buildServer({ actor: owner });
      const gradeMalformedUrl = `/api/v1/courses/${RUBRIC_SLUG}/lessons/${MALFORMED_RUBRIC_SLUG}/submissions/${student.id}/grade`;

      // Scoring against it is refused for the same reason an exercise with
      // no rubric block at all refuses: there is nothing declared to score.
      const scored = await teacher.inject({
        method: 'POST',
        url: gradeMalformedUrl,
        payload: { rubricScores: [{ criterion: 'Effort', points: 1 }] },
      });
      expect(scored.statusCode).toBe(400);
      expect((JSON.parse(scored.payload) as { message: string }).message).toMatch(/no rubric block/);

      // ...and the submission is still gradeable by annotation and return.
      const returned = await teacher.inject({ method: 'POST', url: gradeMalformedUrl, payload: {} });
      expect(returned.statusCode).toBe(200);
      expect((JSON.parse(returned.payload) as SubmissionBody).status).toBe('returned');

      await teacher.close();
    });

    it('rolls a grade back whole when the database refuses a write mid-transaction', async () => {
      const { student, submission } = await freshSubmission();
      const teacher = await buildServer({ actor: owner });

      // The rubric scores are written BEFORE the annotations, so a failure
      // on the annotation insert is precisely the half-finished grade the
      // rollback exists to prevent: scores stored, feedback lost, and the
      // student's work still showing as awaiting review.
      const response = await teacher.inject({
        method: 'POST',
        url: gradeUrl(student.id),
        payload: {
          rubricScores: [
            { criterion: 'Spotted the shallow module', points: 5 },
            { criterion: 'Review tone', points: 3 },
          ],
          annotations: [{ blockIndex: 1, startLine: 1, endLine: 1, body: `Has a NUL:${NUL}in it.` }],
        },
      });
      expect(response.statusCode).toBe(500);

      const scores = await pool.query<{ c: number }>(
        'select count(*)::int as c from rubric_scores where submission_id = $1',
        [submission.id],
      );
      expect(scores.rows[0]!.c).toBe(0);
      const after = await pool.query<{ status: string; returned_at: Date | null }>(
        'select status, returned_at from exercise_submissions where id = $1',
        [submission.id],
      );
      expect(after.rows[0]!.status).toBe('submitted');
      expect(after.rows[0]!.returned_at).toBeNull();

      // The connection came back to the pool usable, so the next grade
      // succeeds rather than inheriting an aborted transaction.
      const retried = await teacher.inject({
        method: 'POST',
        url: gradeUrl(student.id),
        payload: {
          rubricScores: [
            { criterion: 'Spotted the shallow module', points: 5 },
            { criterion: 'Review tone', points: 3 },
          ],
          annotations: [{ blockIndex: 1, startLine: 1, endLine: 1, body: 'Ordinary feedback this time.' }],
        },
      });
      expect(retried.statusCode).toBe(200);

      await teacher.close();
    });

    // =========================================================================
    // THE GRADING QUEUE (design §9.4: "Teachers get a queue of submissions
    // awaiting review across the courses they own."). Nested inside this
    // describe block so it can reuse `owner`/`otherTeacher`/RUBRIC_SLUG — the
    // point being tested is specifically that the queue spans MULTIPLE
    // courses owned by the same teacher, so a second, separate course is
    // imported and given to `owner` too.
    // =========================================================================
    describe('grading queue: GET /api/v1/grading/queue', () => {
      const SECOND_COURSE_SLUG = `queue-second-course-${RUN_ID}`;
      const SECOND_EXERCISE_SLUG = 'exercises-ex01';
      const queueUrl = '/api/v1/grading/queue';

      interface QueueItemBody {
        submissionId: string;
        courseSlug: string;
        courseTitle: string;
        lessonSlug: string;
        lessonTitle: string;
        userId: string;
        studentDisplayName: string | null;
        studentHandle: string | null;
        submittedAt: string;
      }

      beforeAll(async () => {
        const dir = path.join(tmpRoot, 'queue-second-course');
        await importDir(
          await writeCourseDir(dir, SECOND_COURSE_SLUG, [
            { file: 'modules/exercises/ex01.md', body: exerciseMarkdown('Second Course Exercise', ORIGINAL_CODE) },
          ]),
        );
        await pool.query(`update courses set visibility = 'open', owner_id = $2 where slug = $1`, [
          SECOND_COURSE_SLUG,
          owner.id,
        ]);
      });

      it('spans every course the actor owns, oldest submitted first, excluding drafts and returned work', async () => {
        // Submitted on the rubric course — belongs in the queue.
        const queuedStudent = await newStudent('Queue Student One');
        const queuedServer = await buildServer({ actor: queuedStudent });
        await queuedServer.inject({
          method: 'PUT',
          url: submissionUrl(RUBRIC_SLUG, RUBRIC_EXERCISE_SLUG),
          payload: { annotations: [] },
        });
        const queuedSubmitted = await queuedServer.inject({
          method: 'POST',
          url: `${submissionUrl(RUBRIC_SLUG, RUBRIC_EXERCISE_SLUG)}/submit`,
        });
        const queuedBody = JSON.parse(queuedSubmitted.payload) as SubmissionBody;
        await queuedServer.close();

        // Submitted on the SECOND course, owned by the same teacher — proves
        // the queue is not scoped to one course at a time.
        const secondStudent = await newStudent('Queue Student Two');
        const secondServer = await buildServer({ actor: secondStudent });
        await secondServer.inject({
          method: 'PUT',
          url: submissionUrl(SECOND_COURSE_SLUG, SECOND_EXERCISE_SLUG),
          payload: { annotations: [] },
        });
        const secondSubmitted = await secondServer.inject({
          method: 'POST',
          url: `${submissionUrl(SECOND_COURSE_SLUG, SECOND_EXERCISE_SLUG)}/submit`,
        });
        const secondBody = JSON.parse(secondSubmitted.payload) as SubmissionBody;
        await secondServer.close();

        // A draft, never submitted — must never appear in a queue of work
        // "awaiting review".
        const draftStudent = await newStudent('Draft Not Submitted');
        const draftServer = await buildServer({ actor: draftStudent });
        await draftServer.inject({
          method: 'PUT',
          url: submissionUrl(RUBRIC_SLUG, RUBRIC_EXERCISE_SLUG),
          payload: { annotations: [] },
        });
        await draftServer.close();

        // Already graded and returned — reviewed, so it must drop off the queue.
        const { student: returnedStudent, submission: returnedSubmission } = await freshSubmission();
        const grader = await buildServer({ actor: owner });
        await grader.inject({
          method: 'POST',
          url: gradeUrl(returnedStudent.id),
          payload: {
            rubricScores: [
              { criterion: 'Spotted the shallow module', points: 5 },
              { criterion: 'Review tone', points: 3 },
            ],
          },
        });
        await grader.close();

        const teacher = await buildServer({ actor: owner });
        const response = await teacher.inject({ method: 'GET', url: queueUrl });
        expect(response.statusCode).toBe(200);
        const items = JSON.parse(response.payload) as QueueItemBody[];
        const ids = items.map((i) => i.submissionId);

        expect(ids).toContain(queuedBody.id);
        expect(ids).toContain(secondBody.id);
        expect(ids).not.toContain(returnedSubmission.id);
        expect(items.some((i) => i.userId === draftStudent.id)).toBe(false);

        expect(items.find((i) => i.submissionId === queuedBody.id)).toMatchObject({
          courseSlug: RUBRIC_SLUG,
          lessonSlug: RUBRIC_EXERCISE_SLUG,
          userId: queuedStudent.id,
          studentDisplayName: 'Queue Student One',
          studentHandle: null,
        });
        expect(items.find((i) => i.submissionId === secondBody.id)).toMatchObject({
          courseSlug: SECOND_COURSE_SLUG,
          lessonSlug: SECOND_EXERCISE_SLUG,
          userId: secondStudent.id,
        });

        // Oldest submitted first — the order a queue is worked.
        expect(ids.indexOf(queuedBody.id)).toBeLessThan(ids.indexOf(secondBody.id));

        await teacher.close();
      });

      it('a teacher who owns no courses sees an empty queue, never another teacher\'s work', async () => {
        const outsider = await buildServer({ actor: otherTeacher });
        const response = await outsider.inject({ method: 'GET', url: queueUrl });
        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.payload) as unknown[]).toEqual([]);
        await outsider.close();
      });

      it('a student is refused — 403', async () => {
        const student = await newStudent('Not A Teacher');
        const server = await buildServer({ actor: student });
        const response = await server.inject({ method: 'GET', url: queueUrl });
        expect(response.statusCode).toBe(403);
        await server.close();
      });

      it('an anonymous caller is refused — 403', async () => {
        const server = await buildServer({ actor: undefined });
        const response = await server.inject({ method: 'GET', url: queueUrl });
        expect(response.statusCode).toBe(403);
        await server.close();
      });
    });
  });
});
