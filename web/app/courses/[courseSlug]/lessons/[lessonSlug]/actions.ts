'use server';

/*
 * Server Action for the "Mark complete" control (design plan, phase 3 web).
 * Runs on the Next.js server, not the browser — this is how the client
 * component below reaches the API without either a CORS-exposed browser
 * fetch or web needing DATABASE_URL (CLAUDE.md rule 1: web talks to the API
 * over HTTP only).
 */

import { markLessonComplete, submitQuizAttempt } from '../../../../../src/lib/api';
import type { LessonProgressDetail, QuizSubmitRequest, QuizSubmitResult } from '../../../../../src/lib/api';

export type MarkCompleteResult = { ok: true; progress: LessonProgressDetail } | { ok: false; message: string };

export async function markLessonCompleteAction(courseSlug: string, lessonSlug: string): Promise<MarkCompleteResult> {
  try {
    const progress = await markLessonComplete(courseSlug, lessonSlug);
    return { ok: true, progress };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Could not mark this lesson complete.' };
  }
}

/*
 * Server Action for the quiz control (Task C, design §9.1). Same reason as
 * markLessonCompleteAction above: this is how the client Quiz component
 * reaches the API's scoring endpoint without a browser-exposed fetch.
 * Scoring itself happens entirely server-side, in the API — this action is
 * a thin relay, not a second place answers get checked.
 */
export type SubmitQuizResult = { ok: true; result: QuizSubmitResult } | { ok: false; message: string };

export async function submitQuizAction(
  courseSlug: string,
  lessonSlug: string,
  answers: QuizSubmitRequest['answers'],
): Promise<SubmitQuizResult> {
  try {
    const result = await submitQuizAttempt(courseSlug, lessonSlug, answers);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Could not submit this quiz.' };
  }
}
