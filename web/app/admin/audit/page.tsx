import type { Metadata } from 'next';
import Link from 'next/link';
import { fetchAuditLog, fetchMe } from '../../../src/lib/api';
import { withAuthRedirect } from '../../../src/lib/require-auth';
import { formatOccurredAt } from '../../../src/lib/activity';
import { auditActionLabel, auditDetail, AUDIT_FILTER_ACTIONS } from '../../../src/lib/invites';
import AdminNav from '../AdminNav';
import styles from './audit.module.css';

export const metadata: Metadata = {
  title: 'Audit log — Learn App',
};

/*
 * The audit log (design §12: "all privileged actions — role changes, budget
 * grants, invite issuance, course publishing — are written to audit_log",
 * and §5's "Read audit log, instance settings", an admin-only row).
 *
 * READ-ONLY, AND NOT MERELY BY OMISSION. The table is append-only in the
 * database — migration 0005 puts a BEFORE UPDATE/DELETE trigger on it — so
 * there is no edit control here to leave out and no way to add one.
 *
 * The filter is a plain <form method="get"> and links, not a client
 * component: a query parameter the server already reads is exactly what a
 * GET form is for, and it keeps this screen working with no JavaScript.
 */
export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string }>;
}) {
  const params = await searchParams;
  const action = typeof params.action === 'string' && params.action !== '' ? params.action : null;

  const [me, entries] = await withAuthRedirect('/admin/audit', () =>
    Promise.all([fetchMe(), fetchAuditLog({ limit: 200, action: action ?? undefined })]),
  );

  return (
    <main className={styles.page}>
      <AdminNav current="/admin/audit" />
      <div className={styles.heading}>
        <h1 className={styles.title}>Audit log</h1>
        <span className={styles.adminBadge}>Admin</span>
      </div>
      <p className={styles.intro}>
        Every privileged action on this instance, newest first — who did it, to what, and when. Append-only: nothing
        here can be edited or erased, including by an admin.
      </p>

      <nav className={styles.filters} aria-label="Filter by action">
        <Link className={styles.filter} href="/admin/audit" data-active={action === null}>
          Everything
        </Link>
        {AUDIT_FILTER_ACTIONS.map((candidate) => (
          <Link
            key={candidate}
            className={styles.filter}
            href={`/admin/audit?action=${encodeURIComponent(candidate)}`}
            data-active={action === candidate}
          >
            {auditActionLabel(candidate)}
          </Link>
        ))}
      </nav>

      {entries.length === 0 ? (
        <p className={styles.empty}>
          {action === null ? 'Nothing has been logged yet.' : 'Nothing logged for that action yet.'}
        </p>
      ) : (
        <ol className={styles.list}>
          {entries.map((entry) => {
            const when = formatOccurredAt(entry.occurredAt, me.timezone);
            const detail = auditDetail(entry);
            return (
              <li key={entry.id} className={styles.item}>
                <div className={styles.itemHead}>
                  <span className={styles.action}>{auditActionLabel(entry.action)}</span>
                  <time className={styles.time} dateTime={when.iso} title={when.absolute}>
                    {when.relative}
                  </time>
                </div>
                <p className={styles.actor}>
                  by {entry.actorHandle ? `@${entry.actorHandle}` : (entry.actorId ?? 'the system')}
                  {entry.target ? <span className={styles.target}> · {entry.target}</span> : null}
                </p>
                {detail !== '' ? <p className={styles.detail}>{detail}</p> : null}
              </li>
            );
          })}
        </ol>
      )}
    </main>
  );
}
