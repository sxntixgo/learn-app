import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { getPool } from '../db.ts';
import type { Actor } from '../policy/can.ts';
import { can as defaultCan } from '../policy/can.ts';
import { actorFor } from '../auth/actor.ts';
import { codeLineCount, hashSnapshot, presentBlocks } from '../content/present.ts';

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

/** Loads a course id by slug, or null if no such course exists. Mirrors quiz.ts's helper. */
async function findCourseId(courseSlug: string): Promise<string | null> {
  const result = await getPool().query<{ id: string }>('select id from courses where slug = $1', [courseSlug]);
  return result.rows[0]?.id ?? null;
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

/** The wire form of a submission. `snapshot` is what the reader renders from. */
function serialize(lessonSlug: string, row: SubmissionRow, annotations: AnnotationRow[]): unknown {
  return {
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
  ): Promise<{ courseId: string; lesson: ExerciseLessonRow } | { error: { code: number; message: string } }> {
    const courseId = await findCourseId(courseSlug);
    if (!courseId) {
      return { error: { code: 404, message: `Course not found: ${courseSlug}` } };
    }
    const lesson = await findLiveLesson(courseId, lessonSlug);
    if (!lesson) {
      return { error: { code: 404, message: `Lesson not found: ${lessonSlug}` } };
    }
    return { courseId, lesson };
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
      return reply.code(200).send(serialize(resolved.lesson.slug, submission, annotations));
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

        await client.query('COMMIT');
        return reply.code(200).send(serialize(resolved.lesson.slug, saved, stored));
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
          await client.query('COMMIT');
          return reply.code(200).send(serialize(resolved.lesson.slug, submission!, stored));
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

        const stored = await loadAnnotations(client, saved.id);
        await client.query('COMMIT');
        return reply.code(200).send(serialize(resolved.lesson.slug, saved, stored));
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
  );
}
