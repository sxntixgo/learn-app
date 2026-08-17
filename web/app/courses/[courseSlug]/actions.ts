'use server';

/*
 * Server Actions for the course detail page's two owner/student controls
 * (Task E, design §12): the publish control and the enrol/un-enrol button.
 * Same shape as lessons/[lessonSlug]/actions.ts — runs on the Next.js
 * server, never in the browser, so web never needs a CORS-exposed fetch or
 * DATABASE_URL (CLAUDE.md rule 1).
 */

import { enrolInCourse, setCourseVisibility, unenrolFromCourse } from '../../../src/lib/api';
import type { CourseVisibility, Enrolment } from '../../../src/lib/api';

export type EnrolResult = { ok: true; enrolment: Enrolment } | { ok: false; message: string };

export async function enrolAction(courseSlug: string): Promise<EnrolResult> {
  try {
    const enrolment = await enrolInCourse(courseSlug);
    return { ok: true, enrolment };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Could not enrol in this course.' };
  }
}

export async function unenrolAction(courseSlug: string): Promise<EnrolResult> {
  try {
    const enrolment = await unenrolFromCourse(courseSlug);
    return { ok: true, enrolment };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Could not leave this course.' };
  }
}

export type PublishResult = { ok: true; visibility: CourseVisibility } | { ok: false; message: string };

export async function setVisibilityAction(courseSlug: string, visibility: CourseVisibility): Promise<PublishResult> {
  try {
    const updated = await setCourseVisibility(courseSlug, visibility);
    return { ok: true, visibility: updated.visibility };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Could not update visibility.' };
  }
}
