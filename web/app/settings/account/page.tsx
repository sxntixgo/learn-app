import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { fetchIsAdmin, fetchMeOrNull } from '../../../src/lib/api';
import { loginRedirectPath } from '../../../src/lib/next-path';
import ChangePasswordForm from './ChangePasswordForm';
import DeleteAccountForm from './DeleteAccountForm';
import styles from './account.module.css';

export const metadata: Metadata = {
  title: 'Account — Learn App',
  robots: { index: false, follow: false },
};

/*
 * Data export and account deletion (plan: "Account deletion and data
 * export"). A sibling of /settings/profile rather than a section bolted
 * onto it, for a reason found in the policy matrix, not chosen for taste:
 * `profile:read`/`profile:update` (the visibility-settings screen) grant
 * to `student` only (api/src/policy/can.ts), but `me:export`/`me:delete`
 * grant to `student` AND `teacher` — a teacher-only account can leave, and
 * must be able to reach a screen that lets it, but `withAuthRedirect`-style
 * routing on /settings/profile's own `profile:read` 403 for that account
 * (search/page.tsx's module comment documents the resulting infinite
 * redirect loop against /login, confirmed empirically for that page's own
 * role floor). Putting the two together here would have re-created that
 * loop for exactly the account this feature is partly for. Linked to from
 * /settings/profile (the student's home for this) and /grading (the
 * teacher-only account's home), never from a shared entry point that both
 * would have to pass through.
 *
 * Same NOT-`withAuthRedirect` shape as /search for the same reason: a
 * missing session must redirect (there is nothing to show), but a real
 * session `fetchIsAdmin` reports as admin must get a plain sentence, not a
 * loop — admin holds neither grant (`me:export`/`me:delete` have no admin
 * cell: an admin account is instance infrastructure, and self-deleting the
 * last one would leave nobody able to administer it).
 */
export default async function AccountSettingsPage() {
  const me = await fetchMeOrNull();
  if (!me) {
    redirect(loginRedirectPath('/settings/account'));
  }

  const isAdmin = await fetchIsAdmin();

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Account</h1>

      {/*
       * PASSWORD FIRST, AND BEFORE THE ADMIN BRANCH BELOW. `me:password:update`
       * grants to every role, unlike `me:export`/`me:delete` — an admin
       * account is instance infrastructure that cannot leave, but it very much
       * can be compromised, and there is no reset flow anywhere in this design
       * (§2 excludes password-reset mail and SMTP).
       *
       * The admin case used to return early from this page with a single
       * sentence, which is how an admin came to have no way of changing their
       * password at all: the only screen that could host the form refused to
       * render anything else for them.
       */}
      <section className={styles.group} aria-labelledby="password-heading">
        <h2 className={styles.groupTitle} id="password-heading">
          Change your password
        </h2>
        <p className={styles.groupNote}>
          There is no password-reset email on this instance, by design. This form is the only way to change your
          password, so keep the new one somewhere safe. Changing it signs out every other session.
        </p>
        <ChangePasswordForm />
      </section>

      {isAdmin ? (
        <p className={styles.empty}>
          Data export and account deletion aren&rsquo;t available for an admin account — an admin account is
          instance infrastructure, not a learner or teacher record. If you need to leave this instance, ask another
          administrator to remove your admin access first.
        </p>
      ) : (
        <>
      <section className={styles.group} aria-labelledby="export-heading">
        <h2 className={styles.groupTitle} id="export-heading">
          Download your data
        </h2>
        <p className={styles.groupNote}>
          Everything this instance holds about your account, as one JSON file: your profile, enrolments, progress,
          quiz attempts, exercise submissions, badges, degrees, and activity history.
        </p>
        {/* A plain same-origin link, not a client-side fetch: the route it
            points at (app/settings/account/export/route.ts) already sets
            content-disposition: attachment, which is all a browser needs to
            save it as a file on a normal navigation. */}
        <a className={styles.exportLink} href="/settings/account/export">
          Download my data
        </a>
      </section>

      <section className={styles.group} aria-labelledby="delete-heading">
        <h2 className={styles.groupTitle} id="delete-heading">
          Delete your account
        </h2>
        <p className={styles.groupNote}>
          Permanent and irreversible. This removes your account and everything personal to it: your progress,
          enrolments, quiz attempts, exercise submissions (with the annotations and rubric scores on them), badges,
          degrees, profile, signed-in sessions, and activity history.
        </p>

        <div className={styles.noticeBox}>
          <p className={styles.noticeTitle}>What is NOT removed</p>
          <p className={styles.noticeIntro}>
            These are records about other people or about the instance, not about you, so deleting your account
            takes your name off them rather than deleting them:
          </p>
          <ul className={styles.noticeList}>
            <li>Grades and feedback you left on other people&rsquo;s submissions — kept, no longer linked to you.</li>
            <li>Courses you own become unowned, so another teacher can adopt them.</li>
            <li>Invitations you issued, and any roles you granted, remain in effect.</li>
            <li>Audit-log entries describing what you did remain, identified by an id that no longer resolves to any account.</li>
          </ul>
        </div>

        <DeleteAccountForm />
      </section>
        </>
      )}
    </main>
  );
}
