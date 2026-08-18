'use server';

/*
 * Server Action for the grading form (design §9.4, Phase 9). Same thin-relay
 * reasoning as the student-side actions.ts: the client component
 * (GradingForm) never talks to the API directly (CLAUDE.md rule 1), and this
 * action re-implements nothing the API already decided — a 400 (malformed
 * input, or a rubric that does not exactly cover the declared criteria), 403
 * (not this course's owner), or 409 (still a draft) comes back as `message`,
 * verbatim, for the form to show WITHOUT discarding what the teacher typed.
 */

import { gradeSubmission } from '../../../../../../../src/lib/api';
import type { GradeRequest, Submission } from '../../../../../../../src/lib/api';

export type GradeSubmissionResult = { ok: true; submission: Submission } | { ok: false; message: string };

export async function gradeSubmissionAction(
  courseSlug: string,
  lessonSlug: string,
  userId: string,
  body: GradeRequest,
): Promise<GradeSubmissionResult> {
  try {
    const submission = await gradeSubmission(courseSlug, lessonSlug, userId, body);
    return { ok: true, submission };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Could not return this submission.' };
  }
}
