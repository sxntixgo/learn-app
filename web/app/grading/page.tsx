import type { Metadata } from 'next';
import Link from 'next/link';
import { fetchGradingQueue, fetchMe } from '../../src/lib/api';
import { withAuthRedirect } from '../../src/lib/require-auth';
import { formatOccurredAt } from '../../src/lib/activity';
import styles from './grading.module.css';

export const metadata: Metadata = {
  title: 'Grading queue — Learn App',
};

/*
 * The grading queue (design §9.4: "Teachers get a queue of submissions
 * awaiting review across the courses they own"). A role-restricted page —
 * `GET /api/v1/grading/queue` is gated by `submission:queue:read`, a role
 * floor for teachers (api/src/policy/can.ts) — following the same shape as
 * /admin/imports (CLAUDE.md's other role-restricted page): `withAuthRedirect`
 * sends a signed-out visitor to /login, and the API's own 403 becomes the
 * same `AuthRequiredError` here (web/src/lib/api-errors.ts treats 401 and
 * 403 alike), so a signed-in student hitting this URL directly is sent to
 * sign in rather than shown a queue that would 403 anyway — the same
 * treatment every other ownership/role-gated page in this app already gives
 * a 403 (e.g. a course the actor cannot read).
 *
 * The Nav destination itself is hidden from students (web/src/lib/nav.ts,
 * app/layout.tsx's `fetchIsTeacher`) — this page's own guard is the second,
 * load-bearing layer, not the only one.
 */
export default async function GradingQueuePage() {
  const [me, queue] = await withAuthRedirect('/grading', () => Promise.all([fetchMe(), fetchGradingQueue()]));

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Grading queue</h1>
      <p className={styles.intro}>
        Submissions awaiting review across the courses you own, oldest first. A submission drops off this list the
        moment you return it.
      </p>

      {queue.length === 0 ? (
        <p className={styles.empty}>
          Nothing is waiting on you right now. When a student submits an exercise in a course you own, it will show
          up here.
        </p>
      ) : (
        <ol className={styles.list}>
          {queue.map((item) => {
            const submitted = formatOccurredAt(item.submittedAt, me.timezone);
            const student = item.studentDisplayName ?? (item.studentHandle ? `@${item.studentHandle}` : 'A student');
            const href =
              `/courses/${encodeURIComponent(item.courseSlug)}/lessons/${encodeURIComponent(item.lessonSlug)}` +
              `/submissions/${encodeURIComponent(item.userId)}` +
              `?student=${encodeURIComponent(student)}&courseTitle=${encodeURIComponent(item.courseTitle)}&lessonTitle=${encodeURIComponent(item.lessonTitle)}`;

            return (
              <li key={item.submissionId} className={styles.item}>
                <Link href={href} className={styles.link}>
                  <span className={styles.student}>{student}</span>
                  <span className={styles.meta}>
                    {item.courseTitle} · {item.lessonTitle}
                  </span>
                  <time className={styles.time} dateTime={submitted.iso} title={submitted.absolute}>
                    Submitted {submitted.absolute}
                  </time>
                </Link>
              </li>
            );
          })}
        </ol>
      )}

      {/*
       * The way in to account export/deletion (plan: "Account deletion and
       * data export") for a teacher-only account. `me:export`/`me:delete`
       * (api/src/policy/can.ts) grant to `teacher` as well as `student`,
       * but this account's own home is here, not /me or /settings/profile —
       * both of those gate on student-only actions (`me:heatmap:read`,
       * `profile:read`) and 403 for a teacher-only session, which
       * `withAuthRedirect` turns into the same infinite /login redirect
       * loop documented in search/page.tsx's module comment. This page's
       * own gate (`submission:queue:read`) is teacher-only, so anyone who
       * reached this far already holds the grant those two screens need.
       */}
      <p className={styles.accountLinkRow}>
        <Link href="/settings/account" className={styles.accountLink}>
          Export my data or delete my account
        </Link>
      </p>
    </main>
  );
}
