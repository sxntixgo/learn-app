import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { getPool } from '../db.ts';
import type { Actor } from '../policy/can.ts';
import { can as defaultCan } from '../policy/can.ts';
import { actorFor } from '../auth/actor.ts';
import { codeLineCount, hashSnapshot, presentBlocks } from '../content/present.ts';
import { evaluateAndAward, noAwards } from '../progression/award.ts';
import type { AwardNotice } from '../progression/award.ts';

// ---------------------------------------------------------------------------
// EXERCISE SUBMISSIONS (design §9.4, §9.1).
//
// THE RULE THIS MODULE SERVES, quoted because everything below is downstream
// of it:
//
//   "Submissions snapshot the block content as presented, and annotations
//    anchor to the snapshot — never to the live lesson."
//
// Concretely, three things follow.
//
// 1. THE SNAPSHOT IS TAKEN ONCE, ON FIRST SAVE, and read from
//    `presentBlocks(lesson.blocks)` — the same function routes/courses.ts
//    uses to serialize a lesson, so the frozen copy is provably the form the
//    student was shown, not the raw row behind it. Every later save reads the
//    STORED snapshot and never looks at the lesson again. Migration 0011's
//    trigger enforces that even against this module.
//
// 2. ANCHORS ARE VALIDATED AGAINST THAT SNAPSHOT, and an anchor that does not
//    fit is REFUSED (400), never clamped. Clamping is how "line 14" quietly
//    becomes a comment about a line the student never read;
//    web/src/lib/annotations.ts makes the same choice on the rendering side.
//
// 3. SUBMITTING COMPLETES THE LESSON (§9.1: "exercises complete on SUBMIT,
//    not on teacher return — a private course of one has no grader and must
//    still be able to finish") and emits exactly one `exercise_submitted`
//    event, idempotently — the same lock-then-read technique progress.ts and
//    quiz.ts use.
//
// THE ANSWER KEY — A GAP, STATED RATHER THAN INVENTED
// ---------------------------------------------------
// Design §9.4 says submitting "unlocks the answer key". THERE IS NO
// ANSWER-KEY MECHANISM IN THE CONTENT MODEL YET: schemas/blocks.schema.json
// admits `prose`, `code` and `quiz` only; no block type, and no field on any
// of them, marks content as a solution to be revealed after submission
// (`rubric` — the closest thing §9.4 describes — is Phase 9, and a rubric is
// criteria, not an answer key). Inventing one here would mean inventing a
// block type outside the schema, which is exactly what CLAUDE.md rule 5 and
// the schema's own "do NOT add block types early" note forbid. So the unlock
// is NOT implemented, and the hook for it is unambiguous when the block type
// lands: `status !== 'draft'` on the actor's own submission is the condition,
// and this route already reports it.
// ---------------------------------------------------------------------------

export interface SubmissionRouteDeps {
  // Injectable policy function (CLAUDE.md rule 2), same seam as every other
  // route module.
  can?: typeof defaultCan;
  actor?: Actor;
}

/** Sanity bounds on user input. A submission is a code review, not a data store. */
const MAX_ANNOTATIONS = 500;
const MAX_BODY_LENGTH = 10_000;

interface ExerciseLessonRow {
  id: string;
  slug: string;
  kind: string;
  blocks: unknown;
}

interface SubmissionRow {
  id: string;
  status: 'draft' | 'submitted' | 'returned';
  snapshot: unknown;
  snapshot_hash: string;
  submitted_at: string | null;
  returned_at: string | null;
  created_at: string;
  updated_at: string;
}

interface AnnotationRow {
  id: string;
  block_index: number;
  start_line: number;
  end_line: number;
  body: string;
  track: string | null;
  parent_id: string | null;
  author_id: string;
  created_at: string;
}

/** One annotation as the client sends it. Anchors are 1-indexed and inclusive. */
interface AnnotationInput {
  blockIndex: number;
  startLine: number;
  endLine: number;
  body: string;
  track?: string | null;
}

interface RubricScoreRow {
  id: string;
  criterion: string;
  points: string;
  max: string;
  track: string | null;
  scored_by: string;
  created_at: string;
  updated_at: string;
}

/**
 * One rubric criterion's score, as a teacher submits it to POST .../grade.
 * `max` is deliberately absent — Task C: never trust the client for a
 * criterion's ceiling, read it from the submission's own snapshot instead
 * (see matchRubricScores).
 */
interface RubricScoreInput {
  criterion: string;
  points: number;
}

/**
 * One annotation a teacher adds while grading. Distinct from AnnotationInput
 * (the student's shape) because a REPLY carries no anchor of its own — see
 * the module header near the grading routes for why.
 */
interface GradeAnnotationInput {
  parentId: string | null;
  blockIndex: number | null;
  startLine: number | null;
  endLine: number | null;
  body: string;
  track: string | null;
}

/** Loads a course by slug, or null if no such course exists. Mirrors quiz.ts's helper. */
async function findCourse(courseSlug: string): Promise<{ id: string; ownerId: string | null } | null> {
  const result = await getPool().query<{ id: string; owner_id: string | null }>(
    'select id, owner_id from courses where slug = $1',
    [courseSlug],
  );
  const row = result.rows[0];
  return row ? { id: row.id, ownerId: row.owner_id } : null;
}

/**
 * Loads a live (non-archived, non-archived-module) lesson by slug within a
 * course, including its blocks — the same visibility rule as every other
 * lesson-scoped route in this codebase.
 */
async function findLiveLesson(courseId: string, lessonSlug: string): Promise<ExerciseLessonRow | null> {
  const result = await getPool().query<ExerciseLessonRow>(
    `select l.id, l.slug, l.kind, l.blocks
       from lessons l
       join modules m on m.id = l.module_id
      where l.course_id = $1 and l.slug = $2 and l.archived_at is null and m.archived_at is null`,
    [courseId, lessonSlug],
  );
  return result.rows[0] ?? null;
}

/**
 * Shape validation, before any database work. Returns an error message or
 * null. Anchors are checked separately, against the snapshot — see
 * `anchorError`.
 */
function inputError(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return 'annotations must be an array of { blockIndex, startLine, endLine, body }.';
  }
  if (value.length > MAX_ANNOTATIONS) {
    return `A submission may carry at most ${MAX_ANNOTATIONS} annotations.`;
  }

  for (const [index, raw] of value.entries()) {
    if (typeof raw !== 'object' || raw === null) {
      return `annotations[${index}] must be an object.`;
    }
    const { blockIndex, startLine, endLine, body, track } = raw as Record<string, unknown>;

    if (!Number.isInteger(blockIndex) || (blockIndex as number) < 0) {
      return `annotations[${index}].blockIndex must be a non-negative integer.`;
    }
    if (!Number.isInteger(startLine) || (startLine as number) < 1) {
      return `annotations[${index}].startLine must be an integer of at least 1.`;
    }
    if (!Number.isInteger(endLine) || (endLine as number) < 1) {
      return `annotations[${index}].endLine must be an integer of at least 1.`;
    }
    // Refused, never reordered: a range the caller got backwards is a bug in
    // the caller, and silently swapping the ends would anchor the comment to
    // a span nobody chose.
    if ((endLine as number) < (startLine as number)) {
      return `annotations[${index}]: endLine (${String(endLine)}) is before startLine (${String(startLine)}).`;
    }
    if (typeof body !== 'string' || body.trim() === '') {
      return `annotations[${index}].body must be a non-empty string.`;
    }
    if (body.length > MAX_BODY_LENGTH) {
      return `annotations[${index}].body exceeds ${MAX_BODY_LENGTH} characters.`;
    }
    if (track !== undefined && track !== null && (typeof track !== 'string' || track.trim() === '')) {
      return `annotations[${index}].track must be a non-empty string when present.`;
    }
  }

  return null;
}

function normalizeInput(value: unknown[]): AnnotationInput[] {
  return value.map((raw) => {
    const { blockIndex, startLine, endLine, body, track } = raw as Record<string, unknown>;
    const trackValue = typeof track === 'string' && track.trim() !== '' ? track.trim() : null;
    return {
      blockIndex: blockIndex as number,
      startLine: startLine as number,
      endLine: endLine as number,
      body: (body as string).trim(),
      track: trackValue,
    };
  });
}

/**
 * THE ANCHOR CHECK. Every annotation must land on a real code block of THE
 * SNAPSHOT, within its real line count.
 *
 * Read against the snapshot and never against the lesson: that is what makes
 * an anchor stable for the life of the submission, since migration 0011
 * forbids the snapshot from ever changing. An out-of-range anchor is an
 * error, not something to clamp — see the module header.
 */
function anchorError(snapshot: unknown, annotations: readonly AnnotationInput[]): string | null {
  const blocks = Array.isArray(snapshot) ? snapshot : [];

  for (const [index, annotation] of annotations.entries()) {
    const block = blocks[annotation.blockIndex] as { type?: unknown; source?: unknown } | undefined;
    if (block === undefined || block.type !== 'code' || typeof block.source !== 'string') {
      return `annotations[${index}]: block ${annotation.blockIndex} of this submission is not an annotatable code block.`;
    }
    const lines = codeLineCount(block.source);
    if (annotation.endLine > lines) {
      return `annotations[${index}]: lines ${annotation.startLine}-${annotation.endLine} fall outside block ${annotation.blockIndex}, which has ${lines} lines.`;
    }
  }

  return null;
}

async function loadAnnotations(client: pg.PoolClient | pg.Pool, submissionId: string): Promise<AnnotationRow[]> {
  const { rows } = await client.query<AnnotationRow>(
    `select id, block_index, start_line, end_line, body, track, parent_id, author_id, created_at
       from annotations
      where submission_id = $1
      order by block_index, start_line, end_line, created_at, id`,
    [submissionId],
  );
  return rows;
}

/** Loads a submission's rubric scores (design §9.4, Task C) — empty until a teacher grades it. */
async function loadRubricScores(client: pg.PoolClient | pg.Pool, submissionId: string): Promise<RubricScoreRow[]> {
  const { rows } = await client.query<RubricScoreRow>(
    `select id, criterion, points, max, track, scored_by, created_at, updated_at
       from rubric_scores
      where submission_id = $1
      order by criterion`,
    [submissionId],
  );
  return rows;
}

/** The wire form of a submission. `snapshot` is what the reader renders from. */
function serialize(
  lessonSlug: string,
  row: SubmissionRow,
  annotations: AnnotationRow[],
  rubricScores: RubricScoreRow[],
  /**
   * What THIS request earned (design §9.3). Passed only by the submit
   * route, the one request on a submission that completes a lesson — a GET
   * or a draft save earns nothing, and a grading write earns things for the
   * STUDENT, who is not the caller reading this response.
   */
  awarded?: AwardNotice,
): unknown {
  return {
    ...(awarded === undefined ? {} : { awarded }),
    id: row.id,
    lessonSlug,
    status: row.status,
    snapshot: row.snapshot,
    snapshotHash: row.snapshot_hash,
    annotations: annotations.map((a) => ({
      id: a.id,
      blockIndex: a.block_index,
      startLine: a.start_line,
      endLine: a.end_line,
      body: a.body,
      track: a.track,
      parentId: a.parent_id,
      authorId: a.author_id,
      createdAt: a.created_at,
    })),
    // numeric columns arrive as strings off `pg` (no type parser registered
    // — see db.ts); Number() here is the one place that matters, since this
    // is the JSON a browser reads scores from.
    rubricScores: rubricScores.map((r) => ({
      id: r.id,
      criterion: r.criterion,
      points: Number(r.points),
      max: Number(r.max),
      track: r.track,
      scoredBy: r.scored_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
    submittedAt: row.submitted_at,
    returnedAt: row.returned_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SUBMISSION_COLUMNS = `id, status, snapshot, snapshot_hash, submitted_at, returned_at, created_at, updated_at`;

/**
 * Loads the actor's submission for this lesson, locking it for the rest of
 * the transaction.
 *
 * `user_id = $1` with the ACTOR's own id is the only way this table is ever
 * queried in this module: there is no request shape that names another user,
 * so "a student reaches only their own submission" is a property of the SQL,
 * not only of the policy call above it (design §9.4's visibility rule; the
 * teacher's half is `submission:grade`, Phase 9).
 */
async function lockSubmission(
  client: pg.PoolClient,
  userId: string,
  lessonId: string,
): Promise<SubmissionRow | undefined> {
  const { rows } = await client.query<SubmissionRow>(
    `select ${SUBMISSION_COLUMNS} from exercise_submissions
      where user_id = $1 and lesson_id = $2 for update`,
    [userId, lessonId],
  );
  return rows[0];
}

/**
 * Creates the submission, freezing the snapshot from the lesson AS PRESENTED.
 *
 * This is the only place in the codebase that reads `lessons.blocks` into a
 * submission, and it happens exactly once per submission.
 */
async function createSubmission(
  client: pg.PoolClient,
  userId: string,
  lesson: ExerciseLessonRow,
): Promise<SubmissionRow> {
  const snapshotJson = JSON.stringify(presentBlocks(lesson.blocks));
  const { rows } = await client.query<SubmissionRow>(
    `insert into exercise_submissions (user_id, lesson_id, status, snapshot, snapshot_hash)
     values ($1, $2, 'draft', $3::jsonb, $4)
     returning ${SUBMISSION_COLUMNS}`,
    [userId, lesson.id, snapshotJson, hashSnapshot(snapshotJson)],
  );
  return rows[0]!;
}

async function replaceAnnotations(
  client: pg.PoolClient,
  submission: SubmissionRow,
  authorId: string,
  annotations: readonly AnnotationInput[],
): Promise<void> {
  // A draft is the current state of the student's work, not an append log,
  // so a save replaces the set wholesale. Ids are therefore server-assigned
  // and stable only from submit onward — which is all Phase 9's threading
  // needs, since a submitted submission accepts no further draft writes.
  await client.query('delete from annotations where submission_id = $1', [submission.id]);

  for (const annotation of annotations) {
    await client.query(
      // snapshot_hash is written from the submission row rather than from
      // anything the caller supplied: the composite FK (migration 0011)
      // makes an annotation name the snapshot it was written against, and
      // that name must come from the snapshot itself.
      `insert into annotations
         (submission_id, snapshot_hash, author_id, block_index, start_line, end_line, body, track)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        submission.id,
        submission.snapshot_hash,
        authorId,
        annotation.blockIndex,
        annotation.startLine,
        annotation.endLine,
        annotation.body,
        annotation.track,
      ],
    );
  }
}

/** Registers the exercise-submission routes (design §9.4) on `fastify`. */
export function registerSubmissionRoutes(fastify: FastifyInstance, deps: SubmissionRouteDeps = {}): void {
  const can = deps.can ?? defaultCan;

  /**
   * Resolves course + lesson, or the reply that should be sent instead.
   * Shared by all three routes so they cannot drift apart on what "this
   * lesson is reachable" means.
   */
  async function resolveLesson(
    courseSlug: string,
    lessonSlug: string,
  ): Promise<
    | { courseId: string; ownerId: string | null; lesson: ExerciseLessonRow }
    | { error: { code: number; message: string } }
  > {
    const course = await findCourse(courseSlug);
    if (!course) {
      return { error: { code: 404, message: `Course not found: ${courseSlug}` } };
    }
    const lesson = await findLiveLesson(course.id, lessonSlug);
    if (!lesson) {
      return { error: { code: 404, message: `Lesson not found: ${lessonSlug}` } };
    }
    // `ownerId` rides along unused by the three student routes below (they
    // are SELF-scoped, not OWN_COURSE) and is what lets the grading routes
    // further down reuse this exact function rather than re-querying
    // `courses` a second time.
    return { courseId: course.id, ownerId: course.ownerId, lesson };
  }

  /**
   * Design §9.1: one rule per kind, never two competing notions of "done".
   * A lesson or quiz reaching here means the caller is at the wrong endpoint
   * — 409, the same status progress.ts and quiz.ts use for the mirror-image
   * mistake.
   */
  function wrongKind(lesson: ExerciseLessonRow): string | null {
    if (lesson.kind === 'exercise') return null;
    return `Only lessons of kind "exercise" have submissions; this lesson is kind "${lesson.kind}".`;
  }

  // -------------------------------------------------------------------------
  // GET — the actor's own submission.
  // -------------------------------------------------------------------------
  fastify.get<{ Params: { courseSlug: string; lessonSlug: string } }>(
    '/api/v1/courses/:courseSlug/lessons/:lessonSlug/submission',
    async (request, reply) => {
      // Resolved per request from the access-token cookie (auth/actor.ts):
      // the anonymous actor when there is no valid session, never a bypass.
      const actor = actorFor(request, deps);
      const { courseSlug, lessonSlug } = request.params;

      const resolved = await resolveLesson(courseSlug, lessonSlug);
      if ('error' in resolved) {
        return reply.code(resolved.error.code).send({ message: resolved.error.message });
      }

      // Same SELF ownership context as lesson:progress:write — a submission
      // is about the actor's own work, nothing else. A teacher reads a
      // student's submission through `submission:grade` (Phase 9), which is
      // ownership-scoped to their own course.
      if (!can(actor, 'lesson:exercise:read', { slug: resolved.lesson.slug, userId: actor.id })) {
        return reply.code(403).send({ message: 'Forbidden' });
      }

      const { rows } = await getPool().query<SubmissionRow>(
        `select ${SUBMISSION_COLUMNS} from exercise_submissions where user_id = $1 and lesson_id = $2`,
        [actor.id, resolved.lesson.id],
      );
      const submission = rows[0];
      if (!submission) {
        // "You have not started this exercise" is a 404 on the submission,
        // not an empty object — the caller (web/src/lib/api.ts) turns it
        // into `null`, exactly as it does for a course that is not there.
        return reply.code(404).send({ message: `No submission yet for lesson: ${lessonSlug}` });
      }

      const annotations = await loadAnnotations(getPool(), submission.id);
      const rubricScores = await loadRubricScores(getPool(), submission.id);
      return reply.code(200).send(serialize(resolved.lesson.slug, submission, annotations, rubricScores));
    },
  );

  // -------------------------------------------------------------------------
  // PUT — save a draft.
  // -------------------------------------------------------------------------
  fastify.put<{ Params: { courseSlug: string; lessonSlug: string }; Body: { annotations?: unknown } }>(
    '/api/v1/courses/:courseSlug/lessons/:lessonSlug/submission',
    async (request, reply) => {
      const actor = actorFor(request, deps);
      const { courseSlug, lessonSlug } = request.params;
      const body = request.body ?? {};

      const resolved = await resolveLesson(courseSlug, lessonSlug);
      if ('error' in resolved) {
        return reply.code(resolved.error.code).send({ message: resolved.error.message });
      }

      if (!can(actor, 'lesson:exercise:save', { slug: resolved.lesson.slug, userId: actor.id })) {
        return reply.code(403).send({ message: 'Forbidden' });
      }

      const kindError = wrongKind(resolved.lesson);
      if (kindError) {
        return reply.code(409).send({ message: kindError });
      }

      const shapeError = inputError(body.annotations);
      if (shapeError) {
        return reply.code(400).send({ message: shapeError });
      }
      const annotations = normalizeInput(body.annotations as unknown[]);

      const client = await getPool().connect();
      try {
        await client.query('BEGIN');

        let submission = await lockSubmission(client, actor.id, resolved.lesson.id);

        // THE REFUSAL THAT MATTERS: a submitted or returned submission is
        // finished work — the student's, and by then possibly the teacher's
        // too. A draft save must not quietly become an edit of it. 409, with
        // the state named, rather than a silent no-op that leaves the
        // student believing their new comments were saved.
        if (submission && submission.status !== 'draft') {
          await client.query('ROLLBACK');
          return reply.code(409).send({
            message:
              submission.status === 'returned'
                ? 'This submission has been graded and returned; it can no longer be edited.'
                : 'This submission has already been submitted; it can no longer be edited.',
          });
        }

        // The snapshot to validate against: the STORED one for an existing
        // draft (never re-read from the lesson — that is the whole rule),
        // and the lesson as presented only when there is nothing yet.
        const snapshot = submission ? submission.snapshot : presentBlocks(resolved.lesson.blocks);
        const badAnchor = anchorError(snapshot, annotations);
        if (badAnchor) {
          // Rolls back before the row is created, so a rejected first save
          // leaves no half-started submission behind.
          await client.query('ROLLBACK');
          return reply.code(400).send({ message: badAnchor });
        }

        submission ??= await createSubmission(client, actor.id, resolved.lesson);

        await replaceAnnotations(client, submission, actor.id, annotations);
        const touched = await client.query<SubmissionRow>(
          `update exercise_submissions set updated_at = now() where id = $1 returning ${SUBMISSION_COLUMNS}`,
          [submission.id],
        );
        const saved = touched.rows[0]!;
        const stored = await loadAnnotations(client, saved.id);
        // A draft is never graded (the grade route 409s on status 'draft'),
        // so this is always empty here — loaded anyway so the response
        // shape is identical across every submission route, not a special
        // case a client has to remember.
        const storedRubricScores = await loadRubricScores(client, saved.id);

        await client.query('COMMIT');
        return reply.code(200).send(serialize(resolved.lesson.slug, saved, stored, storedRubricScores));
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST .../submit — hand it in.
  // -------------------------------------------------------------------------
  fastify.post<{ Params: { courseSlug: string; lessonSlug: string } }>(
    '/api/v1/courses/:courseSlug/lessons/:lessonSlug/submission/submit',
    async (request, reply) => {
      const actor = actorFor(request, deps);
      const { courseSlug, lessonSlug } = request.params;

      const resolved = await resolveLesson(courseSlug, lessonSlug);
      if ('error' in resolved) {
        return reply.code(resolved.error.code).send({ message: resolved.error.message });
      }

      if (!can(actor, 'lesson:exercise:submit', { slug: resolved.lesson.slug, userId: actor.id })) {
        return reply.code(403).send({ message: 'Forbidden' });
      }

      const kindError = wrongKind(resolved.lesson);
      if (kindError) {
        return reply.code(409).send({ message: kindError });
      }

      // Deliberately takes NO annotations. Drafts are written through PUT,
      // and keeping the two apart is what makes both properties provable at
      // once: submitting is idempotent (a retried request is safe), and a
      // submitted or returned submission cannot be edited by any request at
      // all.
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');

        // Lock-then-read, the same idempotence technique as progress.ts and
        // quiz.ts: the state is decided BEFORE the write, so a second submit
        // sees `alreadySubmitted` and emits no second event.
        let submission = (await lockSubmission(client, actor.id, resolved.lesson.id)) ?? null;
        const alreadySubmitted = submission !== null && submission.status !== 'draft';

        if (alreadySubmitted) {
          const stored = await loadAnnotations(client, submission!.id);
          const storedRubricScores = await loadRubricScores(client, submission!.id);
          await client.query('COMMIT');
          // Nothing changed, so nothing was earned: a retried submit
          // reports no awards, exactly as it emits no second activity
          // event.
          return reply
            .code(200)
            .send(serialize(resolved.lesson.slug, submission!, stored, storedRubricScores, noAwards()));
        }

        // Submitting an exercise never opened is legitimate — an exercise
        // may be answered with no annotations at all — and still needs a
        // snapshot of what was on screen.
        submission ??= await createSubmission(client, actor.id, resolved.lesson);

        const updated = await client.query<SubmissionRow>(
          `update exercise_submissions
              set status = 'submitted', submitted_at = now(), updated_at = now()
            where id = $1
        returning ${SUBMISSION_COLUMNS}`,
          [submission.id],
        );
        const saved = updated.rows[0]!;

        // Design §9.1: an exercise completes on SUBMIT. Not markable through
        // the progress route (which 409s a kind:"exercise" completion), and
        // not dependent on a teacher ever looking at it.
        await client.query(
          `insert into lesson_progress (user_id, lesson_id, state, completed_at, updated_at)
           values ($1, $2, 'complete', now(), now())
           on conflict (user_id, lesson_id) do update set
             state = 'complete',
             completed_at = coalesce(lesson_progress.completed_at, now()),
             updated_at = now()`,
          [actor.id, resolved.lesson.id],
        );

        await client.query(
          `insert into activity_events (user_id, type, course_id, lesson_id, meta)
           values ($1, 'exercise_submitted', $2, $3, $4::jsonb)`,
          [
            actor.id,
            resolved.courseId,
            resolved.lesson.id,
            JSON.stringify({ submissionId: saved.id, snapshotHash: saved.snapshot_hash }),
          ],
        );

        // Design §9.1: an exercise completes on SUBMIT, so this is a
        // progress write like any other and design §9.3's synchronous
        // evaluation applies to it. Same client, same transaction, after
        // the lesson_progress row above — so the exercise just handed in
        // counts toward `exercises_passed`.
        const awarded = await evaluateAndAward(client, actor.id, 'exercise_submitted');

        const stored = await loadAnnotations(client, saved.id);
        const storedRubricScores = await loadRubricScores(client, saved.id);
        await client.query('COMMIT');
        return reply.code(200).send(serialize(resolved.lesson.slug, saved, stored, storedRubricScores, awarded));
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
  );

  // ===========================================================================
  // GRADING (design §9.4, Task C/B). Everything below is the TEACHER'S half
  // of this module; everything above is the student's. Both operate on the
  // same exercise_submissions/annotations rows because grading is, per
  // design §9.4, "an additive layer attaching a score and feedback
  // afterward" to the submission the student already wrote — not a second
  // system.
  //
  // THREADING (Task B). A reply's anchor is DERIVED from its parent, never
  // resent by the caller: `parentId` set means "reply to that annotation, at
  // its own anchor", and blockIndex/startLine/endLine are refused if sent
  // alongside it (400) — a reply can never claim an anchor other than the
  // one it is actually replying to. `parentId` omitted means a fresh
  // top-level annotation (§9.4: "a top-level teacher annotation flags a
  // line the student missed entirely"), validated against the snapshot
  // exactly like a student's own. A reply's parent must itself be
  // top-level — reachable only among rows on THIS submission (the query is
  // `where id = $1 and submission_id = $2`) — so cross-submission threading
  // is structurally impossible before migration 0011's own composite FK
  // (parent_id, submission_id) -> annotations(id, submission_id) ever gets a
  // chance to refuse it as a backstop. A reply to a reply is refused (400):
  // one level is enough for "teacher answers a specific comment", and
  // allowing a second level would need a UI, a fetch shape and a threading
  // rule this design does not ask for — refusing loudly beats flattening
  // silently.
  //
  // RUBRIC SCORING (Task C). `rubricScores` is matched against the exercise's
  // OWN rubric block, read from the SNAPSHOT (never the live lesson — same
  // rule as annotation anchors), and must cover every declared criterion
  // exactly once — see matchRubricScores. `max` is never accepted from the
  // caller.
  // ===========================================================================

  /**
   * Shape validation for `rubricScores`, before any database work — mirrors
   * `inputError`'s role for annotations. Semantic validation (does this
   * criterion exist, is this submission's rubric even declared, is `points`
   * within range) happens in matchRubricScores, against the snapshot.
   */
  function rubricScoreInputError(value: unknown): string | null {
    if (!Array.isArray(value)) {
      return 'rubricScores must be an array of { criterion, points }.';
    }
    for (const [index, raw] of value.entries()) {
      if (typeof raw !== 'object' || raw === null) {
        return `rubricScores[${index}] must be an object.`;
      }
      const { criterion, points } = raw as Record<string, unknown>;
      if (typeof criterion !== 'string' || criterion.trim() === '') {
        return `rubricScores[${index}].criterion must be a non-empty string.`;
      }
      if (typeof points !== 'number' || !Number.isFinite(points) || points < 0) {
        return `rubricScores[${index}].points must be a non-negative number.`;
      }
    }
    return null;
  }

  function normalizeRubricScoreInput(value: unknown[]): RubricScoreInput[] {
    return value.map((raw) => {
      const { criterion, points } = raw as Record<string, unknown>;
      return { criterion: (criterion as string).trim(), points: points as number };
    });
  }

  /**
   * Shape validation for `annotations` on a grade request — mirrors
   * `inputError`, but a reply (`parentId` set) carries no anchor of its own
   * (see the module note above): its blockIndex/startLine/endLine must be
   * ABSENT, refused rather than silently ignored if sent, so a caller never
   * believes it chose an anchor that was actually discarded.
   */
  function gradeAnnotationInputError(value: unknown): string | null {
    if (!Array.isArray(value)) {
      return 'annotations must be an array of { parentId?, blockIndex?, startLine?, endLine?, body, track? }.';
    }
    if (value.length > MAX_ANNOTATIONS) {
      return `A single grade call may add at most ${MAX_ANNOTATIONS} annotations.`;
    }

    for (const [index, raw] of value.entries()) {
      if (typeof raw !== 'object' || raw === null) {
        return `annotations[${index}] must be an object.`;
      }
      const { parentId, blockIndex, startLine, endLine, body, track } = raw as Record<string, unknown>;

      if (parentId !== undefined && parentId !== null && (typeof parentId !== 'string' || parentId.trim() === '')) {
        return `annotations[${index}].parentId must be a string or null.`;
      }
      const isReply = typeof parentId === 'string' && parentId.trim() !== '';

      if (isReply) {
        if (blockIndex !== undefined || startLine !== undefined || endLine !== undefined) {
          return (
            `annotations[${index}] is a reply (parentId set) — blockIndex/startLine/endLine are derived ` +
            `from the annotation it replies to and must not be sent.`
          );
        }
      } else {
        if (!Number.isInteger(blockIndex) || (blockIndex as number) < 0) {
          return `annotations[${index}].blockIndex must be a non-negative integer (required on a top-level annotation).`;
        }
        if (!Number.isInteger(startLine) || (startLine as number) < 1) {
          return `annotations[${index}].startLine must be an integer of at least 1.`;
        }
        if (!Number.isInteger(endLine) || (endLine as number) < 1) {
          return `annotations[${index}].endLine must be an integer of at least 1.`;
        }
        if ((endLine as number) < (startLine as number)) {
          return `annotations[${index}]: endLine (${String(endLine)}) is before startLine (${String(startLine)}).`;
        }
      }

      if (typeof body !== 'string' || body.trim() === '') {
        return `annotations[${index}].body must be a non-empty string.`;
      }
      if (body.length > MAX_BODY_LENGTH) {
        return `annotations[${index}].body exceeds ${MAX_BODY_LENGTH} characters.`;
      }
      if (track !== undefined && track !== null && (typeof track !== 'string' || track.trim() === '')) {
        return `annotations[${index}].track must be a non-empty string when present.`;
      }
    }

    return null;
  }

  function normalizeGradeAnnotationInput(value: unknown[]): GradeAnnotationInput[] {
    return value.map((raw) => {
      const { parentId, blockIndex, startLine, endLine, body, track } = raw as Record<string, unknown>;
      const parentIdValue = typeof parentId === 'string' && parentId.trim() !== '' ? parentId.trim() : null;
      return {
        parentId: parentIdValue,
        blockIndex: parentIdValue === null ? (blockIndex as number) : null,
        startLine: parentIdValue === null ? (startLine as number) : null,
        endLine: parentIdValue === null ? (endLine as number) : null,
        body: (body as string).trim(),
        track: typeof track === 'string' && track.trim() !== '' ? track.trim() : null,
      };
    });
  }

  /**
   * The rubric criteria declared on THIS submission — read from its frozen
   * snapshot, never the live lesson (same rule annotation anchors follow).
   * Defensive rather than throwing: `snapshot` is `unknown` off jsonb, and a
   * shape this doesn't recognise means "no rubric", not a 500.
   */
  function rubricCriteriaOf(snapshot: unknown): Array<{ name: string; max: number; track: string | null }> {
    const blocks = Array.isArray(snapshot) ? snapshot : [];
    for (const block of blocks) {
      if (typeof block !== 'object' || block === null || (block as { type?: unknown }).type !== 'rubric') {
        continue;
      }
      const criteria = (block as { criteria?: unknown }).criteria;
      if (!Array.isArray(criteria)) continue;
      return criteria
        .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
        .map((c) => ({
          name: String(c.name),
          max: Number(c.max),
          track: typeof c.track === 'string' ? c.track : null,
        }));
    }
    return [];
  }

  interface MatchedRubricScore {
    criterion: string;
    points: number;
    max: number;
    track: string | null;
  }

  /**
   * Matches a grade call's rubricScores against the exercise's declared
   * criteria. Every declared criterion must be scored EXACTLY once — Task
   * C: "scores criteria ... in one operation", not a partial write that
   * would leave a graded submission missing feedback on some criteria. When
   * the exercise declares no rubric block at all, rubricScores must be
   * empty. `max`/`track` in the returned rows come from the criterion
   * definition, never the caller.
   */
  function matchRubricScores(
    criteria: Array<{ name: string; max: number; track: string | null }>,
    inputs: readonly RubricScoreInput[],
  ): { rows: MatchedRubricScore[] } | { error: string } {
    if (criteria.length === 0) {
      if (inputs.length > 0) {
        return { error: 'This exercise has no rubric block; rubricScores must be empty.' };
      }
      return { rows: [] };
    }

    const byName = new Map(criteria.map((c) => [c.name, c]));
    const seen = new Set<string>();
    const rows: MatchedRubricScore[] = [];

    for (const input of inputs) {
      const def = byName.get(input.criterion);
      if (!def) {
        const known = criteria.map((c) => c.name).join(', ');
        return {
          error: `rubricScores: "${input.criterion}" is not a criterion declared on this exercise (declared: ${known}).`,
        };
      }
      if (seen.has(input.criterion)) {
        return { error: `rubricScores: "${input.criterion}" is scored twice in the same request.` };
      }
      seen.add(input.criterion);
      if (input.points > def.max) {
        return {
          error: `rubricScores: "${input.criterion}" must score between 0 and ${def.max}, got ${input.points}.`,
        };
      }
      rows.push({ criterion: def.name, points: input.points, max: def.max, track: def.track });
    }

    if (seen.size !== criteria.length) {
      const missing = criteria.filter((c) => !seen.has(c.name)).map((c) => c.name);
      return { error: `rubricScores must cover every declared criterion; missing: ${missing.join(', ')}.` };
    }

    return { rows };
  }

  // -------------------------------------------------------------------------
  // GET — a teacher's view of one student's submission.
  // -------------------------------------------------------------------------
  fastify.get<{ Params: { courseSlug: string; lessonSlug: string; userId: string } }>(
    '/api/v1/courses/:courseSlug/lessons/:lessonSlug/submissions/:userId',
    async (request, reply) => {
      const actor = actorFor(request, deps);
      const { courseSlug, lessonSlug, userId } = request.params;

      const resolved = await resolveLesson(courseSlug, lessonSlug);
      if ('error' in resolved) {
        return reply.code(resolved.error.code).send({ message: resolved.error.message });
      }

      // §9.4: "visible to ... teachers of the owning course". OWN_COURSE,
      // not a role check — see MATRIX's comment on why lesson:exercise:read
      // deliberately has no teacher cell.
      if (!can(actor, 'submission:grade', { course: { ownerId: resolved.ownerId } })) {
        return reply.code(403).send({ message: 'Forbidden' });
      }

      const { rows } = await getPool().query<SubmissionRow>(
        `select ${SUBMISSION_COLUMNS} from exercise_submissions where user_id = $1 and lesson_id = $2`,
        [userId, resolved.lesson.id],
      );
      const submission = rows[0];
      if (!submission) {
        return reply.code(404).send({ message: `No submission from this student for lesson: ${lessonSlug}` });
      }

      const annotations = await loadAnnotations(getPool(), submission.id);
      const rubricScores = await loadRubricScores(getPool(), submission.id);
      return reply.code(200).send(serialize(resolved.lesson.slug, submission, annotations, rubricScores));
    },
  );

  // -------------------------------------------------------------------------
  // POST .../grade — score criteria and add annotations in one operation.
  // -------------------------------------------------------------------------
  fastify.post<{
    Params: { courseSlug: string; lessonSlug: string; userId: string };
    Body: { rubricScores?: unknown; annotations?: unknown };
  }>(
    '/api/v1/courses/:courseSlug/lessons/:lessonSlug/submissions/:userId/grade',
    async (request, reply) => {
      const actor = actorFor(request, deps);
      const { courseSlug, lessonSlug, userId } = request.params;
      const body = request.body ?? {};

      const resolved = await resolveLesson(courseSlug, lessonSlug);
      if ('error' in resolved) {
        return reply.code(resolved.error.code).send({ message: resolved.error.message });
      }

      const courseCtx = { course: { ownerId: resolved.ownerId } };
      if (!can(actor, 'submission:grade', courseCtx)) {
        return reply.code(403).send({ message: 'Forbidden' });
      }

      // A second, narrower gate: MATRIX carries `submission:grade` and
      // `rubric:score` as two cells of the same row (both OWN_COURSE today,
      // deliberately checked separately — a future instance handing
      // rubric:score to a TA without submission:grade must not have to
      // change this route to get that split for free). Checked against the
      // RAW body (not yet shape-validated) since all this needs to know is
      // "did the caller ask to score anything at all".
      const rubricScoresRaw = body.rubricScores ?? [];
      if (Array.isArray(rubricScoresRaw) && rubricScoresRaw.length > 0 && !can(actor, 'rubric:score', courseCtx)) {
        return reply.code(403).send({ message: 'Forbidden' });
      }

      const kindError = wrongKind(resolved.lesson);
      if (kindError) {
        return reply.code(409).send({ message: kindError });
      }

      const rubricShapeError = rubricScoreInputError(rubricScoresRaw);
      if (rubricShapeError) {
        return reply.code(400).send({ message: rubricShapeError });
      }
      const rubricInputs = normalizeRubricScoreInput(rubricScoresRaw as unknown[]);

      const annotationsRaw = body.annotations ?? [];
      const annotationShapeError = gradeAnnotationInputError(annotationsRaw);
      if (annotationShapeError) {
        return reply.code(400).send({ message: annotationShapeError });
      }
      const annotationInputs = normalizeGradeAnnotationInput(annotationsRaw as unknown[]);

      const client = await getPool().connect();
      try {
        await client.query('BEGIN');

        // Same lockSubmission the student routes use — it is generic on
        // whose (user_id, lesson_id) it locks, and a teacher grading is
        // exactly as much "the current state of this row, held for the rest
        // of the transaction" as a student's own draft save is.
        const submission = await lockSubmission(client, userId, resolved.lesson.id);
        if (!submission) {
          await client.query('ROLLBACK');
          return reply.code(404).send({ message: `No submission from this student for lesson: ${lessonSlug}` });
        }

        // §9.4's flow is submit -> grading queue -> returned. A draft is
        // still the student's own private work in progress (design §9.4:
        // visible to the student who wrote it, and to teachers only via
        // submission:grade — but there is nothing to grade until it is
        // handed in), so grading one is refused rather than treated as an
        // early return.
        if (submission.status === 'draft') {
          await client.query('ROLLBACK');
          return reply.code(409).send({
            message: 'This submission is still a draft; there is nothing to grade until the student submits it.',
          });
        }

        const criteria = rubricCriteriaOf(submission.snapshot);
        const matched = matchRubricScores(criteria, rubricInputs);
        if ('error' in matched) {
          await client.query('ROLLBACK');
          return reply.code(400).send({ message: matched.error });
        }

        // Top-level annotations are validated against the snapshot with the
        // SAME anchorError the student's own PUT route uses — one rule for
        // "does this anchor exist", not two that could drift apart.
        const topLevelInputs = annotationInputs.filter((a) => a.parentId === null);
        const anchorProblem = anchorError(
          submission.snapshot,
          topLevelInputs.map((a) => ({
            blockIndex: a.blockIndex!,
            startLine: a.startLine!,
            endLine: a.endLine!,
            body: a.body,
            track: a.track,
          })),
        );
        if (anchorProblem) {
          await client.query('ROLLBACK');
          return reply.code(400).send({ message: anchorProblem });
        }

        // Resolve every annotation to its final (parentId, anchor) — a
        // top-level one keeps what the caller sent; a reply's anchor comes
        // from its parent row, looked up scoped to THIS submission (Task B:
        // "enforce that structurally, not by convention"). The WHERE clause
        // below is that structure: a parentId belonging to another
        // submission simply is not found here, full stop — and migration
        // 0011's composite FK (parent_id, submission_id) refuses it a
        // second time at insert if this check were ever bypassed.
        interface ResolvedAnnotation {
          parentId: string | null;
          blockIndex: number;
          startLine: number;
          endLine: number;
          body: string;
          track: string | null;
        }
        const resolvedAnnotations: ResolvedAnnotation[] = [];

        for (const [index, input] of annotationInputs.entries()) {
          if (input.parentId === null) {
            resolvedAnnotations.push({
              parentId: null,
              blockIndex: input.blockIndex!,
              startLine: input.startLine!,
              endLine: input.endLine!,
              body: input.body,
              track: input.track,
            });
            continue;
          }

          const parentResult = await client.query<{
            id: string;
            block_index: number;
            start_line: number;
            end_line: number;
            parent_id: string | null;
          }>(
            `select id, block_index, start_line, end_line, parent_id
               from annotations
              where id = $1 and submission_id = $2`,
            [input.parentId, submission.id],
          );
          const parent = parentResult.rows[0];
          if (!parent) {
            await client.query('ROLLBACK');
            return reply.code(400).send({
              message: `annotations[${index}].parentId does not name an existing annotation on this submission.`,
            });
          }
          // Threading is one level (Task B): refused, not flattened, so a
          // caller cannot believe it built a thread that does not exist.
          if (parent.parent_id !== null) {
            await client.query('ROLLBACK');
            return reply.code(400).send({
              message: `annotations[${index}]: cannot reply to a reply — threading is one level.`,
            });
          }

          resolvedAnnotations.push({
            parentId: parent.id,
            blockIndex: parent.block_index,
            startLine: parent.start_line,
            endLine: parent.end_line,
            body: input.body,
            track: input.track,
          });
        }

        // Writes. Rubric scores UPSERT (re-grading updates a criterion in
        // place — db/migrations/0012_rubric_scores.sql's header justifies
        // allowing it); annotations only ever INSERT — a grade call can
        // never edit or delete an existing annotation, the student's or an
        // earlier grading pass's own, which is what makes "the student
        // cannot silently lose feedback they have read" true by
        // construction rather than by policy.
        for (const row of matched.rows) {
          await client.query(
            `insert into rubric_scores (submission_id, criterion, points, max, track, scored_by)
             values ($1, $2, $3, $4, $5, $6)
             on conflict (submission_id, criterion) do update set
               points = excluded.points, max = excluded.max, track = excluded.track,
               scored_by = excluded.scored_by, updated_at = now()`,
            [submission.id, row.criterion, row.points, row.max, row.track, actor.id],
          );
        }

        for (const row of resolvedAnnotations) {
          await client.query(
            `insert into annotations
               (submission_id, snapshot_hash, author_id, parent_id, block_index, start_line, end_line, body, track)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              submission.id,
              submission.snapshot_hash,
              actor.id,
              row.parentId,
              row.blockIndex,
              row.startLine,
              row.endLine,
              row.body,
              row.track,
            ],
          );
        }

        // THE RETURN FLOW (Task C). `returned_at` is stamped once — coalesce
        // leaves a prior value untouched, so a re-grade cannot pretend the
        // feedback arrived again — and status moves to 'returned'
        // unconditionally (idempotent: writing 'returned' over 'returned'
        // changes nothing that matters). Whether THIS call is the one that
        // returns it, decided from state read before any write above, is
        // what gates the activity event next.
        const wasReturned = submission.status === 'returned';
        const updated = await client.query<SubmissionRow>(
          `update exercise_submissions
              set status = 'returned', returned_at = coalesce(returned_at, now()), updated_at = now()
            where id = $1
        returning ${SUBMISSION_COLUMNS}`,
          [submission.id],
        );
        const saved = updated.rows[0]!;

        // Exactly one `exercise_returned` event per submission, ever — the
        // same lock-then-read idempotence technique as every other event in
        // this codebase (progress.ts, quiz.ts, submissions.ts's own submit
        // route). Owned by the STUDENT (design §10: "what tells a student
        // their feedback has arrived"), not the grading teacher.
        if (!wasReturned) {
          await client.query(
            `insert into activity_events (user_id, type, course_id, lesson_id, meta)
             values ($1, 'exercise_returned', $2, $3, $4::jsonb)`,
            [userId, resolved.courseId, resolved.lesson.id, JSON.stringify({ submissionId: saved.id, gradedBy: actor.id })],
          );
        }

        // Grading writes rubric_scores on a RETURNED submission, which is
        // half of a track score (progression/track-score.ts) — so a
        // `track_score` badge can become due here, and criteria.ts's
        // `submission_graded` row is exactly that one type.
        //
        // Evaluated for the STUDENT (`userId`), never for the grading
        // teacher, and deliberately NOT reported in this response: an
        // AwardNotice says what the CALLER earned, and the caller here is
        // the teacher. The student learns of it from their own next read.
        await evaluateAndAward(client, userId, 'submission_graded');

        const storedAnnotations = await loadAnnotations(client, saved.id);
        const storedRubricScores = await loadRubricScores(client, saved.id);
        await client.query('COMMIT');
        return reply.code(200).send(serialize(resolved.lesson.slug, saved, storedAnnotations, storedRubricScores));
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/v1/grading/queue — submissions awaiting review across every
  // course the actor owns (design §9.4: "Teachers get a queue of submissions
  // awaiting review across the courses they own"). Gated by
  // `submission:queue:read`, a role floor (see can.ts's comment on that
  // cell) — the real scoping is `c.owner_id = actor.id` below, not a
  // resource `can()` checks, because there is no single course to name.
  // -------------------------------------------------------------------------
  fastify.get('/api/v1/grading/queue', async (request, reply) => {
    const actor = actorFor(request, deps);

    if (!can(actor, 'submission:queue:read')) {
      return reply.code(403).send({ message: 'Forbidden' });
    }

    // Only `submitted` — not yet `returned` — is "awaiting review": a
    // returned submission has already been graded. Joined through modules
    // to exclude archived content, the same visibility findLiveLesson gives
    // every other lesson-scoped route, so a queue entry always resolves when
    // the teacher clicks into it. Oldest submitted first — the order a
    // queue is worked — with `submission_id` as a final, stable tiebreaker.
    const { rows } = await getPool().query<{
      submission_id: string;
      course_slug: string;
      course_title: string;
      lesson_slug: string;
      lesson_title: string;
      user_id: string;
      display_name: string | null;
      handle: string | null;
      submitted_at: string;
    }>(
      `select es.id as submission_id,
              c.slug as course_slug, c.title as course_title,
              l.slug as lesson_slug, l.title as lesson_title,
              u.id as user_id, u.display_name, u.handle,
              es.submitted_at
         from exercise_submissions es
         join lessons l on l.id = es.lesson_id
         join modules m on m.id = l.module_id
         join courses c on c.id = l.course_id
         join users u on u.id = es.user_id
        where c.owner_id = $1
          and es.status = 'submitted'
          and l.archived_at is null
          and m.archived_at is null
        order by es.submitted_at asc, es.id asc`,
      [actor.id],
    );

    return reply.code(200).send(
      rows.map((row) => ({
        submissionId: row.submission_id,
        courseSlug: row.course_slug,
        courseTitle: row.course_title,
        lessonSlug: row.lesson_slug,
        lessonTitle: row.lesson_title,
        userId: row.user_id,
        studentDisplayName: row.display_name,
        studentHandle: row.handle,
        submittedAt: row.submitted_at,
      })),
    );
  });
}
