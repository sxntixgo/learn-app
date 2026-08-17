import type { Metadata } from 'next';
import { fetchImportRuns, fetchMe } from '../../../src/lib/api';
import { withAuthRedirect } from '../../../src/lib/require-auth';
import ImportForm from './ImportForm';
import ImportHistory from './ImportHistory';
import styles from './imports.module.css';

export const metadata: Metadata = {
  title: 'Import content — Learn App',
};

/*
 * The admin content-import screen (design plan phase 5; design doc §4/§8,
 * item 6 of §14's build order: "Admin — repo list, import run log with
 * errors, invite table" — this phase builds the import + run-log half).
 *
 * UNAUTHENTICATED UNTIL PHASE 6 — see api/src/routes/admin.ts. Reachable by
 * anyone on the LAN today; that is a documented, deliberate gap closed at
 * Gate 6, not an oversight.
 *
 * History timestamps render in the actor's own timezone (design §15),
 * resolved once here via /api/v1/me and threaded down — same pattern as
 * /me's heatmap/activity feed.
 */
export default async function AdminImportsPage() {
  const [me, runs] = await withAuthRedirect('/admin/imports', () => Promise.all([fetchMe(), fetchImportRuns(50)]));

  return (
    <main className={styles.page}>
      <div className={styles.heading}>
        <h1 className={styles.title}>Import content</h1>
        <span className={styles.adminBadge}>Admin</span>
      </div>
      <p className={styles.intro}>
        Clone a content repo, validate its manifest and lessons, and write it into the catalog. Runs synchronously —
        a course this size takes seconds — with progress below as it happens.
      </p>

      <section className={styles.section} aria-labelledby="import-form-heading">
        <h2 className={styles.sectionTitle} id="import-form-heading">
          New import
        </h2>
        <ImportForm />
      </section>

      <section className={styles.section} aria-labelledby="import-history-heading">
        <h2 className={styles.sectionTitle} id="import-history-heading">
          Run history
        </h2>
        <ImportHistory runs={runs} timezone={me.timezone} />
      </section>
    </main>
  );
}
