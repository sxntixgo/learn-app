/**
 * Checkpoint display helpers (design §9.1, artboard-spec §7 Q2 — "Checkpoint
 * is a quiz-kind lesson at the existing route"). `QuizBlock.pass` is stored
 * as a fraction (openapi.yaml: "e.g. 0.7"), but PL6/P7's eyebrow states the
 * threshold as a whole-question count — "CHECKPOINT · 2 QUESTIONS · PASS AT
 * 2" — so this is the one place that count is derived, kept in sync with
 * how the API actually grades (`api/src/routes/quiz.ts`: `passed = score >=
 * quizBlock.pass`, where `score = correctCount / total`). The minimum
 * integer `correctCount` satisfying that is `ceil(pass * total)`; the small
 * epsilon subtracted before rounding is cheap insurance against a fraction
 * landing a hair above a whole number in floating point and being rounded
 * up one question too many.
 */
export function quizPassThreshold(pass: number, totalQuestions: number): number {
  if (totalQuestions <= 0) return 0;
  const threshold = Math.ceil(pass * totalQuestions - 1e-9);
  return Math.max(0, Math.min(totalQuestions, threshold));
}

/**
 * The checkpoint eyebrow text (PL6/P7): "Checkpoint · N questions · Pass at
 * M". Written in sentence case here — `lesson.module.css`'s `.eyebrow`
 * applies `text-transform: uppercase` unconditionally, the same way it
 * already did for the generic "Lesson N · M min" string it replaces.
 */
export function checkpointEyebrow(totalQuestions: number, pass: number): string {
  const threshold = quizPassThreshold(pass, totalQuestions);
  const noun = totalQuestions === 1 ? 'question' : 'questions';
  return `Checkpoint · ${totalQuestions} ${noun} · Pass at ${threshold}`;
}
