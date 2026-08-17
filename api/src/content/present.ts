import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// THE PRESENTATION FORM OF A LESSON'S BLOCKS.
//
// `lessons.blocks` as stored is not what a student sees: the stored quiz
// block carries `correct` on its choices, and the browser must never receive
// it (design §9.1 — quizzes are machine-scored server-side). One function
// decides what "as presented" means, and it lives here rather than inside a
// route because TWO callers now need the identical answer:
//
//   - routes/courses.ts, serializing a lesson into a response, and
//   - routes/submissions.ts, freezing an exercise's snapshot.
//
// Design §9.4 says a submission snapshots "the block content AS PRESENTED".
// If the snapshot were taken from the raw row while the reader got the
// stripped form, a teacher grading a month-late submission would be looking
// at something the student never saw — which is the same class of failure as
// letting the anchor drift, just quieter. Sharing this function is what makes
// the two forms provably the same one.
// ---------------------------------------------------------------------------

/**
 * Strips `correct` from every quiz choice before a lesson's blocks leave the
 * API. The database keeps the full block — the scoring route (routes/quiz.ts)
 * needs it — this is the one chokepoint that keeps the answer key out of page
 * source; every other reader of `lessons.blocks` in this codebase (the
 * importer, the scoring route) intentionally goes straight to the row and
 * does NOT go through this function.
 *
 * Defensive rather than blocks-schema-typed: `blocks` arrives as `unknown`
 * off a jsonb column, and a block this function doesn't recognise (or a shape
 * that doesn't match what it expects) is returned unchanged rather than
 * throwing — a stripping bug must never become a 500 on every lesson page.
 */
export function presentBlocks(blocks: unknown): unknown {
  if (!Array.isArray(blocks)) return blocks;

  return blocks.map((block) => {
    if (typeof block !== 'object' || block === null || (block as { type?: unknown }).type !== 'quiz') {
      return block;
    }

    const quiz = block as { questions?: unknown };
    if (!Array.isArray(quiz.questions)) return block;

    const questions = quiz.questions.map((question) => {
      if (typeof question !== 'object' || question === null) return question;
      const { choices, ...restOfQuestion } = question as { choices?: unknown; [key: string]: unknown };
      if (!Array.isArray(choices)) return question;

      const strippedChoices = choices.map((choice) => {
        if (typeof choice !== 'object' || choice === null) return choice;
        const rest: Record<string, unknown> = { ...(choice as Record<string, unknown>) };
        delete rest.correct;
        return rest;
      });

      return { ...restOfQuestion, choices: strippedChoices };
    });

    return { ...quiz, questions };
  });
}

/**
 * The fingerprint of a snapshot — `exercise_submissions.snapshot_hash`, and
 * the composite-FK partner every annotation carries (migration 0011).
 *
 * Hashes the JSON exactly as it will be stored, so "the hash still matches"
 * and "the bytes are still the ones the student submitted" are the same
 * statement. Deliberately NOT key-order-normalising: the snapshot is written
 * once and never rewritten, so there is no second serialization to reconcile
 * with, and a normaliser would only add a way for the hash to disagree with
 * the column it describes.
 */
export function hashSnapshot(snapshotJson: string): string {
  return createHash('sha256').update(snapshotJson).digest('hex');
}

/**
 * The number of source lines a code block has, counted the way
 * web/src/lib/annotations.ts counts them — which is what every stored anchor
 * is expressed in.
 *
 * The trailing-newline case is the one that matters: shiki emits a final
 * empty line span for a source ending in "\n", and the web splitter drops it
 * so that `lines.length` equals the line count of the file the author wrote.
 * An anchor validated here against a different count than the browser renders
 * would either reject a legitimate last-line annotation or accept one that
 * renders nowhere.
 */
export function codeLineCount(source: string): number {
  const lines = source.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return Math.max(1, lines.length);
}
