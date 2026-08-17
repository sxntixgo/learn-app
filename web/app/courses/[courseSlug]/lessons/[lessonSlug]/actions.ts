'use server';

/*
 * Server Action for the "Mark complete" control (design plan, phase 3 web).
 * Runs on the Next.js server, not the browser — this is how the client
 * component below reaches the API without either a CORS-exposed browser
 * fetch or web needing DATABASE_URL (CLAUDE.md rule 1: web talks to the API
 * over HTTP only).
 */

import {
  markLessonComplete,
  saveSubmissionDraft,
  submitQuizAttempt,
  submitSubmission,
} from '../../../../../src/lib/api';
import type {
  LessonProgressDetail,
  QuizSubmitRequest,
  QuizSubmitResult,
  Submission,
  SubmissionAnnotationInput,
} from '../../../../../src/lib/api';

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

/*
 * Server Actions for the annotatable-exercise flow (Phase 8, design §9.4).
 * Same thin-relay reasoning as the two actions above: the client component
 * (ExercisePanel) never talks to the API directly (CLAUDE.md rule 1), and
 * neither action re-implements anything the API already decided — a 400
 * (bad anchor), 409 (already submitted/returned, or wrong lesson kind), or
 * 403 comes back as `message`, verbatim, for the caller to show.
 */
export type SaveDraftResult = { ok: true; submission: Submission } | { ok: false; message: string };

export async function saveSubmissionDraftAction(
  courseSlug: string,
  lessonSlug: string,
  annotations: SubmissionAnnotationInput[],
): Promise<SaveDraftResult> {
  try {
    const submission = await saveSubmissionDraft(courseSlug, lessonSlug, annotations);
    return { ok: true, submission };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Could not save your draft.' };
  }
}

export type SubmitExerciseResult = { ok: true; submission: Submission } | { ok: false; message: string };

export async function submitExerciseAction(
  courseSlug: string,
  lessonSlug: string,
): Promise<SubmitExerciseResult> {
  try {
    const submission = await submitSubmission(courseSlug, lessonSlug);
    return { ok: true, submission };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Could not submit this exercise.' };
  }
}
