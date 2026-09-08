import type { Metadata } from 'next';
import { AuthRequiredError, fetchCourses, fetchInvites, fetchIsTeacher, fetchMe } from '../../src/lib/api';
import { withAuthRedirect } from '../../src/lib/require-auth';
import InviteForm from './InviteForm';
import InviteList from './InviteList';
import styles from './invites.module.css';

export const metadata: Metadata = {
  title: 'Invitations — Learn App',
};

/*
 * The invitations screen (design §12).
 *
 * ONE SCREEN FOR BOTH SCOPES. `GET /api/v1/invites` already answers with
 * everything for an admin and with their own for a teacher, so a second
 * "admin invites" page would be the same table twice with a different
 * heading — and the second copy is the one that would rot. What differs is
 * WHAT MAY BE ISSUED: §5's "Invite to a course" has no admin cell, so the
 * course option renders only for a teacher (`fetchIsTeacher`, the same
 * probe the nav uses), and the platform option is always there because
 * admins are unlimited and teachers spend a budget.
 *
 * Role-gated exactly like /grading and /admin/imports: `withAuthRedirect`
 * sends a signed-out visitor to /login, and the API's 403 for a student
 * arrives here as the same AuthRequiredError, so a student who types the
 * URL is asked to sign in rather than shown a table that would 403.
 */
export default async function InvitesPage() {
  const [me, invites, isTeacher] = await withAuthRedirect('/invites', () =>
    Promise.all([fetchMe(), fetchInvites(200), fetchIsTeacher()]),
  );

  // Suggestions for the course field only; a teacher's own hidden course may
  // not be in the catalog, so the field stays free text and the API's
  // ownership check is what actually decides (never this list).
  //
  // `GET /api/v1/courses` is `course:list`, which has no teacher cell of its
  // own (§5.1: reading the catalog is a STUDENT power, even for a teacher's
  // own course) — a teacher-only account, one with no `student` role, gets a
  // 403 here. That is ordinary, not exceptional: whether the account can
  // browse the catalog says nothing about whether it may issue an invite, so
  // this degrades to "no suggestions" (`fetchCanInvite`/`fetchCanSearch`
  // treat their own floor's refusal the same way) instead of throwing outside
  // `withAuthRedirect` above — which crashed the render entirely, past the
  // root layout, for exactly this account shape.
  let courses: Awaited<ReturnType<typeof fetchCourses>> = [];
  if (isTeacher) {
    try {
      courses = await fetchCourses();
    } catch (err) {
      if (!(err instanceof AuthRequiredError)) throw err;
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.heading}>
        <h1 className={styles.title}>Invitations</h1>
      </div>
      <p className={styles.intro}>
        Registration on this instance is by invitation only. One link both registers the person and enrols them in
        the course it names.
      </p>

      <section className={styles.section} aria-labelledby="invite-form-heading">
        <h2 className={styles.sectionTitle} id="invite-form-heading">
          New invitation
        </h2>
        <InviteForm
          courses={courses}
          canInviteToCourse={isTeacher}
          // An admin's platform invitations are unlimited (§12), so the
          // budget line is meaningless for them and is left off rather than
          // shown as a number that never moves.
          remainingBudget={isTeacher ? me.inviteBudget : null}
        />
      </section>

      <section className={styles.section} aria-labelledby="invite-list-heading">
        <h2 className={styles.sectionTitle} id="invite-list-heading">
          {isTeacher ? 'Your invitations' : 'Every invitation'}
        </h2>
        <InviteList invites={invites} timezone={me.timezone} />
      </section>
    </div>
  );
}
