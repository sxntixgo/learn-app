import type { Metadata } from 'next';
import { fetchAdminUsers } from '../../../src/lib/api';
import { withAuthRedirect } from '../../../src/lib/require-auth';
import AdminNav from '../AdminNav';
import PersonCard from './PersonCard';
import styles from './people.module.css';

export const metadata: Metadata = {
  title: 'People — Learn App',
};

/*
 * The admin roster (design §5's "Assign roles, grant invite budgets", §12's
 * budgets).
 *
 * Admin-restricted the same way /admin/imports and /grading are: the API
 * gates `GET /api/v1/admin/users` on `user:list`, an admin-only cell of the
 * §5 matrix, and its 403 arrives here as the AuthRequiredError
 * `withAuthRedirect` turns into a trip to /login. There is deliberately no
 * role check in this file — that decision lives in one tested policy
 * module, not scattered across pages (CLAUDE.md rule 2).
 */
export default async function AdminPeoplePage() {
  const people = await withAuthRedirect('/admin/people', () => fetchAdminUsers(200));

  return (
    <main className={styles.page}>
      <AdminNav current="/admin/people" />
      <div className={styles.heading}>
        <h1 className={styles.title}>People</h1>
        <span className={styles.adminBadge}>Admin</span>
      </div>
      <p className={styles.intro}>
        Every account on this instance. Roles are a set, not a ladder — student and teacher combine freely, and admin
        is exclusive of both: an operator account learns nothing, so a stolen session is not a takeover.
      </p>

      {people.length === 0 ? (
        <p className={styles.empty}>No accounts yet.</p>
      ) : (
        <ul className={styles.list}>
          {people.map((person) => (
            <PersonCard key={person.id} person={person} />
          ))}
        </ul>
      )}
    </main>
  );
}
