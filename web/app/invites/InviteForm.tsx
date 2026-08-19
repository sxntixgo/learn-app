'use client';

/*
 * Issuing one invitation (design §12: "one action issues one link that both
 * registers the person and enrolls them in the course").
 *
 * THE LINK IS SHOWN EXACTLY ONCE. Only the SHA-256 of the token is stored,
 * so the API can never show it again — this component therefore keeps the
 * issued link on screen until the issuer dismisses it, rather than
 * refreshing it away, and says plainly that it cannot be recovered. A lost
 * link is revoked and re-issued.
 *
 * The course option only renders for a teacher: §5's "Invite to a course |
 * own courses" has no admin cell, so offering it to an admin would be a
 * control whose only possible outcome is a 403.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { CourseSummary, InviteKind, IssuedInvite } from '../../src/lib/api';
import { issueInviteAction } from './actions';
import styles from './invites.module.css';

export default function InviteForm({
  courses,
  canInviteToCourse,
  remainingBudget,
}: {
  courses: CourseSummary[];
  canInviteToCourse: boolean;
  remainingBudget: number | null;
}) {
  const router = useRouter();
  const [kind, setKind] = useState<InviteKind>(canInviteToCourse ? 'course' : 'platform');
  const [email, setEmail] = useState('');
  const [courseSlug, setCourseSlug] = useState('');
  const [expiresInDays, setExpiresInDays] = useState('14');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssuedInvite | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);

    const days = Number(expiresInDays);
    const result = await issueInviteAction({
      kind,
      email: email.trim().toLowerCase(),
      courseSlug: kind === 'course' ? courseSlug.trim() : undefined,
      expiresInDays: Number.isFinite(days) ? days : undefined,
    });

    setSubmitting(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }

    setIssued(result.issued);
    setEmail('');
    // The list below is a server component; this is what makes the new row
    // (and the issuer's new budget) appear without a manual reload.
    router.refresh();
  }

  return (
    <div className={styles.formSection}>
      <form className={styles.form} onSubmit={handleSubmit}>
        {canInviteToCourse ? (
          <fieldset className={styles.fieldset}>
            <legend className={styles.legend}>What this invitation grants</legend>
            <label className={styles.radioLabel}>
              <input
                type="radio"
                name="kind"
                value="course"
                checked={kind === 'course'}
                onChange={() => setKind('course')}
                disabled={submitting}
              />
              <span>
                A course — registers them if they are new, and enrols them either way
              </span>
            </label>
            <label className={styles.radioLabel}>
              <input
                type="radio"
                name="kind"
                value="platform"
                checked={kind === 'platform'}
                onChange={() => setKind('platform')}
                disabled={submitting}
              />
              <span>The platform — creates an account, with no course attached</span>
            </label>
          </fieldset>
        ) : null}

        <div className={styles.field}>
          <label className={styles.label} htmlFor="invite-email">
            Email address
          </label>
          <input
            id="invite-email"
            className={styles.input}
            type="email"
            inputMode="email"
            autoComplete="off"
            required
            value={email}
            disabled={submitting}
            onChange={(e) => setEmail(e.target.value)}
          />
          <p className={styles.hint}>The link only works for this address.</p>
        </div>

        {kind === 'course' ? (
          <div className={styles.field}>
            <label className={styles.label} htmlFor="invite-course">
              Course
            </label>
            <input
              id="invite-course"
              className={styles.input}
              list="invite-course-options"
              required
              value={courseSlug}
              disabled={submitting}
              onChange={(e) => setCourseSlug(e.target.value)}
            />
            <datalist id="invite-course-options">
              {courses.map((course) => (
                <option key={course.slug} value={course.slug}>
                  {course.title}
                </option>
              ))}
            </datalist>
            <p className={styles.hint}>A course you own. Its slug, e.g. intro-to-typescript.</p>
          </div>
        ) : null}

        <div className={styles.field}>
          <label className={styles.label} htmlFor="invite-expiry">
            Expires in <span className={styles.optional}>days</span>
          </label>
          <input
            id="invite-expiry"
            className={styles.inputNarrow}
            type="number"
            min={1}
            max={90}
            value={expiresInDays}
            disabled={submitting}
            onChange={(e) => setExpiresInDays(e.target.value)}
          />
          {remainingBudget !== null ? (
            <p className={styles.hint}>
              Inviting someone who has no account yet spends one of your {remainingBudget} remaining platform
              invitations. It comes back if the link expires or you revoke it.
            </p>
          ) : null}
        </div>

        <button className={styles.submitButton} type="submit" disabled={submitting}>
          {submitting ? 'Issuing…' : 'Issue invitation'}
        </button>
      </form>

      {error !== null ? (
        <p className={styles.requestError} role="alert">
          {error}
        </p>
      ) : null}

      {issued !== null ? (
        <div className={styles.issued} role="status">
          <p className={styles.issuedTitle}>Invitation for {issued.invite.email}</p>
          <p className={styles.issuedLink}>
            <code className={styles.token}>{issued.acceptPath}</code>
          </p>
          <p className={styles.hint}>
            Copy this link now and send it to them yourself — this instance has no mail server, only the link&apos;s
            fingerprint is stored, and it cannot be shown again. If it is lost, revoke the invitation and issue
            another.
          </p>
          <p className={styles.hint}>You have {issued.remainingBudget} platform invitations left.</p>
          <button className={styles.dismissButton} type="button" onClick={() => setIssued(null)}>
            Done
          </button>
        </div>
      ) : null}
    </div>
  );
}
