import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { components } from '../../../../../../../src/lib/api-types';
import { fetchMe, fetchSubmissionForGrading } from '../../../../../../../src/lib/api';
import { withAuthRedirect } from '../../../../../../../src/lib/require-auth';
import { highlightCodeBlocks } from '../../../../../../../src/lib/highlight';
import { formatOccurredAt } from '../../../../../../../src/lib/activity';
import GradingForm from './GradingForm';
import styles from './grading-view.module.css';

type Block = components['schemas']['Block'];
type CodeBlock = Extract<Block, { type: 'code' }>;

const isCodeBlock = (block: Block): block is CodeBlock => block.type === 'code';

export const metadata: Metadata = {
  title: 'Grade submission — Learn App',
};

/*
 * The grading view (design §9.4). Everything a teacher needs to grade one
 * student's submission: the frozen SNAPSHOT rendered through the same
 * AnnotatableCode the student used (read-only plus grading affordances —
 * "reuse AnnotatableCode in read-only mode, do not write a second
 * renderer"), the rubric form, and the deliberate "return" control.
 *
 * Ownership is enforced by the API (`submission:grade`, OWN_COURSE) —
 * `fetchSubmissionForGrading` is routed through `apiFetch`, so a teacher who
 * does not own this course gets the API's 403, which becomes
 * `AuthRequiredError` here and redirects to sign-in via `withAuthRedirect`,
 * the same treatment every other ownership-gated page in this app gives a
 * 403 (design §12's course-visibility pages, /admin/imports, /grading).
 *
 * `student`/`courseTitle`/`lessonTitle` search params are a display nicety
 * carried over from the /grading queue's own link (the API has no
 * "look up a user's display name" endpoint) — entirely cosmetic; every
 * access decision is still the API's, not this page's.
 */
export default async function GradingViewPage({
  params,
  searchParams,
}: {
  params: Promise<{ courseSlug: string; lessonSlug: string; userId: string }>;
  searchParams: Promise<{ student?: string; courseTitle?: string; lessonTitle?: string }>;
}) {
  const { courseSlug, lessonSlug, userId } = await params;
  const { student, courseTitle, lessonTitle } = await searchParams;
  const path = `/courses/${courseSlug}/lessons/${lessonSlug}/submissions/${userId}`;

  const [me, submission] = await withAuthRedirect(path, () =>
    Promise.all([fetchMe(), fetchSubmissionForGrading(courseSlug, lessonSlug, userId)]),
  );

  if (!submission) {
    notFound();
  }

  const blocks: Block[] = submission.snapshot;
  const highlighted = await highlightCodeBlocks(blocks, isCodeBlock);

  const studentLabel = student && student.trim() !== '' ? student : `Student ${userId.slice(0, 8)}`;
  const submitted = submission.submittedAt ? formatOccurredAt(submission.submittedAt, me.timezone) : null;
  const returned = submission.returnedAt ? formatOccurredAt(submission.returnedAt, me.timezone) : null;

  return (
    <main className={styles.page}>
      <Link href="/grading" className={styles.back}>
        ← Grading queue
      </Link>

      <h1 className={styles.title}>{studentLabel}</h1>
      <p className={styles.subtitle}>
        {courseTitle ?? courseSlug} · {lessonTitle ?? lessonSlug}
      </p>
      <p className={styles.status}>
        {submission.status === 'returned' ? 'Returned' : 'Awaiting review'}
        {submitted ? ` · Submitted ${submitted.absolute}` : ''}
        {returned ? ` · Last returned ${returned.absolute}` : ''}
      </p>

      <GradingForm
        courseSlug={courseSlug}
        lessonSlug={lessonSlug}
        userId={userId}
        studentLabel={studentLabel}
        blocks={blocks}
        highlighted={highlighted}
        initialSubmission={submission}
      />
    </main>
  );
}
