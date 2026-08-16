'use server';

/*
 * Server Action for the "Mark complete" control (design plan, phase 3 web).
 * Runs on the Next.js server, not the browser — this is how the client
 * component below reaches the API without either a CORS-exposed browser
 * fetch or web needing DATABASE_URL (CLAUDE.md rule 1: web talks to the API
 * over HTTP only).
 */

import { markLessonComplete } from '../../../../../src/lib/api';
import type { LessonProgressDetail } from '../../../../../src/lib/api';

export type MarkCompleteResult = { ok: true; progress: LessonProgressDetail } | { ok: false; message: string };

export async function markLessonCompleteAction(courseSlug: string, lessonSlug: string): Promise<MarkCompleteResult> {
  try {
    const progress = await markLessonComplete(courseSlug, lessonSlug);
    return { ok: true, progress };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Could not mark this lesson complete.' };
  }
}
