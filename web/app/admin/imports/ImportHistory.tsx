/*
 * Import run history (design plan phase 5, design doc item 6: "import run
 * log with errors"). Purely presentational — no interaction — so this stays
 * a server component; ImportForm above it calls router.refresh() after a
 * run finishes to pull a fresh list.
 */

import type { ImportRunSummary } from '../../../src/lib/api';
import { formatOccurredAt } from '../../../src/lib/activity';
import { shortSha, statusLabel, summarizeImportCounts } from '../../../src/lib/imports';
import styles from './imports.module.css';

export interface ImportHistoryProps {
  runs: ImportRunSummary[];
  /** The actor's effective IANA timezone (design §15) — never UTC-by-default or the server's zone. */
  timezone: string;
}

export default function ImportHistory({ runs, timezone }: ImportHistoryProps) {
  if (runs.length === 0) {
    return <p className={styles.empty}>No imports yet. Run one above and it will show up here.</p>;
  }

  return (
    <ol className={styles.historyList}>
      {runs.map((run) => {
        const started = formatOccurredAt(run.startedAt, timezone);
        const finished = run.finishedAt ? formatOccurredAt(run.finishedAt, timezone) : null;

        return (
          <li key={run.id} className={styles.historyItem}>
            <div className={styles.historyHead}>
              <span className={styles.statusPill} data-status={run.status}>
                {statusLabel(run.status)}
              </span>
              <span className={styles.historySlug}>{run.courseSlug ?? '(manifest not read)'}</span>
              <time className={styles.historyTime} dateTime={started.iso} title={started.absolute}>
                {started.absolute}
              </time>
            </div>

            <dl className={styles.historyMeta}>
              {run.repoUrl ? (
                <div className={styles.historyMetaRow}>
                  <dt>Repo</dt>
                  <dd className={styles.historyMetaValue}>{run.repoUrl}</dd>
                </div>
              ) : null}
              {run.commitSha ? (
                <div className={styles.historyMetaRow}>
                  <dt>Commit</dt>
                  <dd className={styles.historyMetaValue}>
                    <code>{shortSha(run.commitSha)}</code>
                  </dd>
                </div>
              ) : null}
              <div className={styles.historyMetaRow}>
                <dt>Finished</dt>
                <dd className={styles.historyMetaValue}>{finished ? finished.absolute : 'still running'}</dd>
              </div>
            </dl>

            {run.status === 'success' && run.counts ? (
              <p className={styles.historyCounts}>{summarizeImportCounts(run.counts)}</p>
            ) : null}

            {run.status === 'failed' && run.problems.length > 0 ? (
              <ul className={styles.historyProblems}>
                {run.problems.map((problem, index) => (
                  <li key={`${run.id}-problem-${index}`}>{problem}</li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
