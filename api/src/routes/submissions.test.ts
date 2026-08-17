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

const EXERCISE_SLUG = 'exercises-ex01';
const PLAIN_SLUG = 'exercises-plain';

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

interface LessonFixture {
  file: string;
  body: string;
}

async function writeCourseDir(dir: string, slug: string, lessons: LessonFixture[]): Promise<string> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  const manifest = {
    schema: 1,
    slug,
    title: 'Submission Test Course',
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

    // Imported courses land `hidden` (migration 0008) and these tests are
    // about submissions, not visibility — the lesson-read gate is exercised
    // in courses.test.ts.
    await pool.query(`update courses set visibility = 'open' where slug in ($1, $2)`, [
      COURSE_SLUG,
      SNAPSHOT_COURSE_SLUG,
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
});
