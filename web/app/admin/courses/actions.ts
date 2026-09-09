'use server';

/*
 * The admin course-management screen's one mutation this page adds on top
 * of the existing publish control: transferring ownership (design §5's
 * "Publish / set course visibility" row, the admin-only
 * course:ownership:transfer cell). Publishing itself is NOT duplicated here
 * — CourseManageCard.tsx reuses courses/[courseSlug]/actions.ts's
 * `setVisibilityAction` and the PATCH it already calls, per the brief:
 * "reuse the same PATCH and idiom rather than invent a second one."
 *
 * Same non-throwing shape as admin/people/actions.ts: a refusal (403 not
 * this actor's to make, 400 no such user) becomes a message the card shows,
 * not a stack trace.
 */

import { setCourseOwner } from '../../../src/lib/api';
import type { CourseManage } from '../../../src/lib/api';

export type TransferOwnerResult = { ok: true; course: CourseManage } | { ok: false; message: string };

export async function transferOwnershipAction(courseSlug: string, ownerId: string | null): Promise<TransferOwnerResult> {
  try {
    const course = await setCourseOwner(courseSlug, ownerId);
    return { ok: true, course };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Could not transfer ownership.' };
  }
}
