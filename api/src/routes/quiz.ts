import type { FastifyInstance } from 'fastify';
import { getPool } from '../db.ts';
import type { Actor } from '../policy/can.ts';
import { can as defaultCan } from '../policy/can.ts';
import { actorFor } from '../auth/actor.ts';
import type { Block, QuizBlock } from '../content/parse.ts';

// ---------------------------------------------------------------------------
// The quiz scoring endpoint (design §9.1: "quiz — PASSED — the threshold
// declared in the block. NOT MARKABLE."). progress.ts already 409s a direct
// completion attempt on a kind:"quiz" lesson and MUST keep doing that; this
// route is the ONLY other way a quiz lesson's lesson_progress row can become
// 'complete'.
//
// Scoring runs entirely server-side against the STORED block (which carries
// `correct` — see content/parse.ts's QuizChoice doc comment). The browser
// never receives that field (routes/courses.ts strips it before a lesson
// response goes out), so trusting the client's own notion of "which answer
// is right" is not a temptation this file can even have.
// ---------------------------------------------------------------------------

export interface QuizRouteDeps {
  // Injectable policy function (CLAUDE.md rule 2), same seam as every other
  // route module.
  can?: typeof defaultCan;
  actor?: Actor;
}

interface AnswerInput {
  questionIndex: number;
  choiceIndex: number;
}

interface QuizLessonRow {
  id: string;
  slug: string;
  kind: string;
  blocks: Block[];
}

/** One question's outcome — also exactly the shape stored in `quiz_attempts.answers`. */
interface QuestionResult {
  questionIndex: number;
  track: string | null;
  choiceIndex: number | null;
  correctChoiceIndex: number;
  correct: boolean;
}

interface TrackScore {
  correct: number;
  total: number;
}

/** Loads a course id by slug, or null if no such course exists. Mirrors progress.ts's own helper. */
async function findCourseId(courseSlug: string): Promise<string | null> {
  const result = await getPool().query<{ id: string }>('select id from courses where slug = $1', [courseSlug]);
  return result.rows[0]?.id ?? null;
}

/**
 * Loads a live (non-archived, non-archived-module) lesson by slug within a
 * course, including its blocks — the same visibility rule as every other
 * lesson-scoped route in this codebase.
 */
async function findLiveLesson(courseId: string, lessonSlug: string): Promise<QuizLessonRow | null> {
  const result = await getPool().query<QuizLessonRow>(
    `select l.id, l.slug, l.kind, l.blocks
     from lessons l
     join modules m on m.id = l.module_id
     where l.course_id = $1 and l.slug = $2 and l.archived_at is null and m.archived_at is null`,
    [courseId, lessonSlug],
  );
  return result.rows[0] ?? null;
}

function findQuizBlock(blocks: Block[]): QuizBlock | undefined {
  return blocks.find((block): block is QuizBlock => block.type === 'quiz');
}

/** True for anything shaped like `{questionIndex: number, choiceIndex: number}`. */
function isAnswerInput(value: unknown): value is AnswerInput {
  if (typeof value !== 'object' || value === null) return false;
  const { questionIndex, choiceIndex } = value as Record<string, unknown>;
  return Number.isInteger(questionIndex) && Number.isInteger(choiceIndex);
}

function scoreQuiz(quiz: QuizBlock, answers: AnswerInput[]): QuestionResult[] {
  const choiceByQuestion = new Map(answers.map((a) => [a.questionIndex, a.choiceIndex]));

  return quiz.questions.map((question, questionIndex) => {
    const correctChoiceIndex = question.choices.findIndex((choice) => choice.correct === true);
    const choiceIndex = choiceByQuestion.get(questionIndex) ?? null;
    return {
      questionIndex,
      track: question.track ?? null,
      choiceIndex,
      correctChoiceIndex,
      correct: choiceIndex !== null && choiceIndex === correctChoiceIndex,
    };
  });
}

/** Per-track {correct, total} — design §9.1/§9.3, "quiz questions carry a track". */
function trackScoresOf(results: QuestionResult[]): Record<string, TrackScore> {
  const scores: Record<string, TrackScore> = {};
  for (const result of results) {
    if (result.track === null) continue;
    const bucket = scores[result.track] ?? { correct: 0, total: 0 };
    bucket.total += 1;
    if (result.correct) bucket.correct += 1;
    scores[result.track] = bucket;
  }
  return scores;
}

/** Registers the quiz scoring route on `fastify`. */
export function registerQuizRoutes(fastify: FastifyInstance, deps: QuizRouteDeps = {}): void {
  const can = deps.can ?? defaultCan;

  fastify.post<{ Params: { courseSlug: string; lessonSlug: string }; Body: { answers?: unknown } }>(
    '/api/v1/courses/:courseSlug/lessons/:lessonSlug/quiz',
    async (request, reply) => {
      // Resolved per request from the access-token cookie (auth/actor.ts):
      // the anonymous actor when there is no valid session, never a bypass.
      const actor = actorFor(request, deps);

      const { courseSlug, lessonSlug } = request.params;
      const body = request.body ?? {};

      const courseId = await findCourseId(courseSlug);
      if (!courseId) {
        return reply.code(404).send({ message: `Course not found: ${courseSlug}` });
      }

      const lessonRow = await findLiveLesson(courseId, lessonSlug);
      if (!lessonRow) {
        return reply.code(404).send({ message: `Lesson not found: ${lessonSlug}` });
      }

      // Same SELF ownership context as lesson:progress:write — a quiz
      // attempt is about the actor's own record, nothing else.
      if (!can(actor, 'lesson:quiz:submit', { slug: lessonRow.slug, userId: actor.id })) {
        return reply.code(403).send({ message: 'Forbidden' });
      }

      // Design §9.1: quizzes are the only kind scored through this route.
      // A lesson/exercise reaching here means the reader is calling the
      // wrong endpoint, not that anything is broken — 409, same status
      // progress.ts uses for the mirror-image mistake.
      if (lessonRow.kind !== 'quiz') {
        return reply.code(409).send({
          message: `Only lessons of kind "quiz" can be scored through this endpoint; this lesson is kind "${lessonRow.kind}".`,
        });
      }

      const quizBlock = findQuizBlock(lessonRow.blocks);
      if (!quizBlock) {
        // Not reachable through normal content authoring (validateBlocks
        // requires kind:"quiz" lessons to make sense on import), but a
        // defensive 422 beats a 500 if content and kind ever disagree.
        return reply.code(422).send({ message: `Lesson "${lessonSlug}" has no quiz block to score against.` });
      }

      if (!Array.isArray(body.answers) || !body.answers.every(isAnswerInput)) {
        return reply
          .code(400)
          .send({ message: 'answers must be an array of { questionIndex: number, choiceIndex: number }.' });
      }

      const results = scoreQuiz(quizBlock, body.answers);
      const total = results.length;
      const correctCount = results.filter((r) => r.correct).length;
      const score = total === 0 ? 0 : correctCount / total;
      const passed = score >= quizBlock.pass;
      const trackScores = trackScoresOf(results);

      const client = await getPool().connect();
      let attemptId: string;
      let createdAt: string;
      let becameComplete = false;
      try {
        await client.query('BEGIN');

        const attemptResult = await client.query<{ id: string; created_at: string }>(
          `insert into quiz_attempts (user_id, lesson_id, score, passed, answers, track_scores)
           values ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
           returning id, created_at`,
          [actor.id, lessonRow.id, score, passed, JSON.stringify(results), JSON.stringify(trackScores)],
        );
        attemptId = attemptResult.rows[0]!.id;
        createdAt = attemptResult.rows[0]!.created_at;

        if (passed) {
          // Same idempotence technique as progress.ts: lock (if present)
          // and read the current state BEFORE writing, so a retake that
          // passes again sees wasComplete = true and emits no second event
          // — completion is recorded once, exactly as design §9.1 asks,
          // while retaking itself is always allowed (a new attempt row
          // either way).
          const existing = await client.query<{ state: string }>(
            'select state from lesson_progress where user_id = $1 and lesson_id = $2 for update',
            [actor.id, lessonRow.id],
          );
          const wasComplete = existing.rows[0]?.state === 'complete';

          await client.query(
            `insert into lesson_progress (user_id, lesson_id, state, completed_at, updated_at)
             values ($1, $2, 'complete', now(), now())
             on conflict (user_id, lesson_id) do update set
               state = 'complete',
               completed_at = coalesce(lesson_progress.completed_at, now()),
               updated_at = now()`,
            [actor.id, lessonRow.id],
          );

          becameComplete = !wasComplete;

          if (becameComplete) {
            await client.query(
              `insert into activity_events (user_id, type, course_id, lesson_id, meta)
               values ($1, 'quiz_passed', $2, $3, $4::jsonb)`,
              [actor.id, courseId, lessonRow.id, JSON.stringify({ score, trackScores })],
            );
          }
        }

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      return reply.code(200).send({
        score,
        passed,
        pass: quizBlock.pass,
        results,
        trackScores,
        attempt: { id: attemptId, createdAt },
      });
    },
  );
}
