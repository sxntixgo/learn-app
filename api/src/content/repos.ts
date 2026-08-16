import type pg from 'pg';

// ---------------------------------------------------------------------------
// content_repos bookkeeping (design §7, 0002_content_schema.sql).
//
// Split out of import.ts because a repo registration is not scoped to one
// course's transaction: `content_repos` rows outlive any single import and
// (per the schema) may eventually back several courses. Both functions here
// run OUTSIDE importCourse's per-course transaction, on the same connection,
// mirroring how import_runs is opened/closed outside it for the same reason
// (see import.ts's startImportRun comment).
// ---------------------------------------------------------------------------

/**
 * Ensures a `content_repos` row exists for this URL and returns its id.
 *
 * Upserted on `url` (unique per 0002). `defaultRef` is only set when the row
 * is first created — design §7 defines it as "the branch/ref the importer
 * clones when none is specified", a configured default, not a log of the
 * last ref actually cloned. A later import that passes an explicit `--ref`
 * must not overwrite the default a future unspecified import would use.
 */
export async function upsertContentRepo(client: pg.PoolClient, url: string, defaultRef: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into content_repos (url, default_ref)
     values ($1, $2)
     on conflict (url) do update set url = excluded.url
     returning id`,
    [url, defaultRef],
  );
  return rows[0]!.id;
}

/**
 * Marks a repo as synced after a SUCCESSFUL import — 0002 defines
 * `last_synced_at` as "null until the first successful import", so this must
 * only be called once `importCourse` has returned, never before.
 */
export async function markRepoSynced(client: pg.PoolClient, repoId: string): Promise<void> {
  await client.query(`update content_repos set last_synced_at = now() where id = $1`, [repoId]);
}
