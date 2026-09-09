/*
 * One row of the admin/teacher course-management screen. A server
 * component: the only interactive parts are PublishControl (reused as-is
 * from the course detail page — see this file's header comment) and, for
 * an admin, TransferOwnerControl, both client components nested here.
 *
 * `visibility === 'hidden'` and `ownerId === null` each get their own
 * badge, deliberately not folded into one "needs attention" label: a
 * teacher's still-hidden course and an admin's ownerless one are different
 * facts, and the whole reason this page exists is a course that is BOTH at
 * once — a freshly-imported course (migration 0008 lands `hidden`,
 * migration 0007 leaves `owner_id` null) that nothing in the UI could
 * previously reach.
 */

import type { CourseManageSummary } from '../../../src/lib/api';
import PublishControl from '../../courses/[courseSlug]/PublishControl';
import TransferOwnerControl from './TransferOwnerControl';
import styles from './courses.module.css';

export interface CourseManageCardProps {
  course: CourseManageSummary;
  /** Only an admin may transfer ownership (course:ownership:transfer, design §5). */
  isAdmin: boolean;
}

export default function CourseManageCard({ course, isAdmin }: CourseManageCardProps) {
  const hidden = course.visibility === 'hidden';
  const unowned = course.ownerId === null;

  return (
    <li className={styles.item}>
      <div className={styles.itemHead}>
        <span className={styles.courseTitle}>{course.title}</span>
        <span className={styles.slug}>{course.slug}</span>
      </div>

      <div className={styles.badgeRow}>
        <span className={`${styles.badge} ${hidden ? styles.badgeHidden : styles.badgeListed}`}>
          {hidden ? 'Hidden' : course.visibility === 'restricted' ? 'Restricted' : 'Open'}
        </span>
        <span className={`${styles.badge} ${unowned ? styles.badgeNoOwner : styles.badgeOwned}`}>
          {unowned ? 'No owner' : `Owner: ${course.ownerHandle ? `@${course.ownerHandle}` : course.ownerId}`}
        </span>
      </div>

      <div className={styles.controls}>
        <PublishControl courseSlug={course.slug} visibility={course.visibility} />
        {isAdmin ? <TransferOwnerControl courseSlug={course.slug} ownerId={course.ownerId} /> : null}
      </div>
    </li>
  );
}
