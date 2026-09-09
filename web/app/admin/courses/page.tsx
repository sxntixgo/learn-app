import type { Metadata } from 'next';
import { fetchIsAdmin, fetchManageableCourses } from '../../../src/lib/api';
import { withAuthRedirect } from '../../../src/lib/require-auth';
import AdminNav from '../AdminNav';
import CourseManageCard from './CourseManageCard';
import styles from './courses.module.css';

export const metadata: Metadata = {
  title: 'Courses — Learn App',
};

/*
 * The admin/teacher course-management screen (design §5's "Publish / set
 * course visibility" row) — the door an admin otherwise does not have.
 *
 * THE GAP THIS CLOSES: a course an importer registers lands `hidden`
 * (migration 0008 default) with no owner (migration 0007) — the instance's
 * own curriculum content, not any teacher's. `course:manage:read` and
 * `course:visibility:set` already grant an admin override for exactly this
 * course, but nothing in this app ever handed the admin a slug to type:
 * `/courses/{slug}` is gated on `course:read` (student-only — admins
 * manage, they do not consume) and `GET /api/v1/courses` is `course:list`
 * (student-only too). `GET /api/v1/courses/manage` (course:manage:list) is
 * the listing that exists FOR this screen, and it answers the same
 * question for a teacher too: their own courses, exactly like
 * `course:manage:read` already does one course at a time.
 *
 * A denial there is reported as 404 (the `.../manage` precedent — "nothing
 * to disclose to anyone it is not the settings screen for"), which
 * `fetchManageableCourses` turns into the same ForbiddenError every other
 * role-gated page in this app already throws, so `withAuthRedirect` routes
 * a plain student to /no-access and a signed-out visitor to /login without
 * this file knowing the difference.
 *
 * `fetchIsAdmin` decides whether TransferOwnerControl renders at all —
 * course:ownership:transfer is admin-only (design §5), and a teacher who
 * owns a course they see here should not be shown a control the API will
 * only ever 403.
 */
export default async function AdminCoursesPage() {
  const [courses, isAdmin] = await withAuthRedirect('/admin/courses', () =>
    Promise.all([fetchManageableCourses(), fetchIsAdmin()]),
  );

  return (
    <div className={styles.page}>
      <AdminNav current="/admin/courses" />
      <div className={styles.heading}>
        <h1 className={styles.title}>Courses</h1>
        <span className={styles.adminBadge}>Admin</span>
      </div>
      <p className={styles.intro}>
        {isAdmin
          ? 'Every course on this instance. A freshly-imported course lands hidden with no owner — publish it, or hand it to a teacher, below.'
          : 'Every course you own. Publish one to make it visible in the catalog, or restrict it to invited students.'}
      </p>

      {courses.length === 0 ? (
        <p className={styles.empty}>{isAdmin ? 'No courses yet.' : 'You do not own any courses yet.'}</p>
      ) : (
        <ul className={styles.list}>
          {courses.map((course) => (
            <CourseManageCard key={course.slug} course={course} isAdmin={isAdmin} />
          ))}
        </ul>
      )}
    </div>
  );
}
