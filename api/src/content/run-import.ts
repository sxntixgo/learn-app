import type pg from 'pg';
import type { ClonedRepo } from './clone.ts';
import { cloneCourseRepo, removeClone } from './clone.ts';
import type { ImportCounts } from './import.ts';
import { importCourse } from './import.ts';
import { loadCourse } from './manifest.ts';
import { markRepoSynced, upsertContentRepo } from './repos.ts';
import { validateCourseDir } from './validate-dir.ts';

// ---------------------------------------------------------------------------
// The whole admin-import pipeline (design §8): clone -> validate -> parse ->
// write, as one composed, streamable operation.
//
// This is the "admin UI" caller design §8 names alongside the CLI and the
// future Go CI validator — but it cannot literally import
// tools/src/import.ts's importFromUrl, because tools/ depends on @learn/api,
// never the reverse (see CLAUDE.md's workspace layout). So this module is
// the api-side composition, built from the exact same lower-level pieces
// (clone.ts, validate-dir.ts, manifest.ts, import.ts, repos.ts) that
// tools/src/import.ts's importFromUrl composes for the CLI — no pipeline
// logic is reimplemented, only recombined with progress events and its own
// caller (an HTTP route) instead of console.log/console.error.
//
// The one behavioural difference from the CLI, deliberate: a clone or
// validate failure here still writes a `failed` import_runs row (see
// recordPreImportFailure below), where the CLI only prints to stderr. The
// admin history screen (design §14 item 6: "import run log with errors")
// needs every failed attempt to show up, including ones that never reached
// importCourse's own row-writing.
// ---------------------------------------------------------------------------

export type ImportStage = 'cloning' | 'validating' | 'parsing' | 'writing' | 'done' | 'failed';

export interface ImportProgressEvent {
  stage: ImportStage;
  message?: string;
  /** Present only when stage is 'failed'. Every problem found, file:line formatted where applicable (design §8: "error quality is the authoring experience"). */
  problems?: string[];
  /** The import_runs row this attempt was recorded under, once known. */
  importRunId?: string;
  slug?: string;
  commitSha?: string;
  counts?: ImportCounts;
}

export interface RunImportArgs {
  url: string;
  ref?: string;
  /**
   * Same internal-only switch as clone.ts's CloneOptions.allowFileUrl: a
   * TypeScript argument, not something a request body can set. The admin
   * HTTP route (api/src/routes/admin.ts) never passes this — see the
   * comment there. It exists purely so this pipeline's own tests can run
   * hermetically against a `file://` bare repo, the same technique
   * tools/src/import-url.test.ts uses for the CLI.
   */
  allowFileUrl?: boolean;
}

export type RunImportResult =
  | { ok: true; importRunId: string; slug: string; commitSha: string; counts: ImportCounts }
  | { ok: false; problems: string[] };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Splits an Error's message on newlines so a multi-line "file:line: problem" message (planCourse, loadCourse) becomes the same array of problems validateCourseDir would have returned. */
function problemsFromError(err: unknown): string[] {
  return errorMessage(err).split('\n');
}

/**
 * Writes a `failed` import_runs row directly, for a failure that happens
 * BEFORE importCourse is ever called (clone, validate, parse) — importCourse
 * writes its own row (running -> success/failed) for failures at the write
 * stage, so this is never called once importCourse has started (that would
 * double the row for one attempt).
 */
async function recordPreImportFailure(
  client: pg.PoolClient,
  args: { repoId: string | null; slug: string | null; commit: string | null; problems: string[] },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into import_runs (repo_id, course_slug, commit_sha, status, finished_at, log)
     values ($1, $2, $3, 'failed', now(), $4::jsonb)
     returning id`,
    [
      args.repoId,
      args.slug,
      args.commit,
      JSON.stringify({ error: { message: args.problems.join('\n') }, problems: args.problems }),
    ],
  );
  return rows[0]!.id;
}

/**
 * Runs clone -> validate -> parse -> write against `args.url`, reporting
 * each stage to `onEvent` as it starts (and the terminal 'done'/'failed'
 * once the outcome is known).
 *
 * Always removes the temp clone directory before returning, success or
 * failure (design §4: no content left on disk after an import). Never
 * throws — every failure is reported through `onEvent`/the return value, so
 * the caller (a streaming HTTP handler) never has an exception to translate
 * into a stream event after the connection may already be half-written.
 */
export async function runImportPipeline(
  client: pg.PoolClient,
  args: RunImportArgs,
  onEvent: (event: ImportProgressEvent) => void,
): Promise<RunImportResult> {
  const { url, ref, allowFileUrl } = args;

  onEvent({ stage: 'cloning', message: `Cloning ${url}${ref ? ` (ref: ${ref})` : ''}...` });

  let clone: ClonedRepo;
  try {
    clone = await cloneCourseRepo(url, { ref, allowFileUrl });
  } catch (err) {
    const problems = problemsFromError(err);
    const importRunId = await recordPreImportFailure(client, { repoId: null, slug: null, commit: null, problems });
    onEvent({ stage: 'failed', problems, importRunId });
    return { ok: false, problems };
  }

  // Known once upsertContentRepo below resolves; kept in outer scope so the
  // catch-all below can still name the repo on an unexpected failure.
  let repoId: string | null = null;

  try {
    // Registered as soon as the clone succeeds — mirrors
    // tools/src/import.ts's importFromUrl, and means every failure from
    // here on (validate, parse, write) can name the repo it came from.
    repoId = await upsertContentRepo(client, url, ref ?? 'main');

    onEvent({ stage: 'validating', message: 'Validating manifest and lessons...' });
    const validation = await validateCourseDir(clone.dir);
    if (!validation.ok) {
      const importRunId = await recordPreImportFailure(client, {
        repoId,
        slug: validation.slug ?? null,
        commit: clone.commit,
        problems: validation.problems,
      });
      onEvent({ stage: 'failed', problems: validation.problems, importRunId });
      return { ok: false, problems: validation.problems };
    }

    onEvent({ stage: 'parsing', message: 'Parsing lessons...' });
    let course;
    try {
      course = await loadCourse(clone.dir);
    } catch (err) {
      const problems = problemsFromError(err);
      const importRunId = await recordPreImportFailure(client, {
        repoId,
        slug: validation.slug ?? null,
        commit: clone.commit,
        problems,
      });
      onEvent({ stage: 'failed', problems, importRunId });
      return { ok: false, problems };
    }

    onEvent({ stage: 'writing', message: 'Writing to the database...' });
    let result;
    try {
      result = await importCourse(client, course, { commit: clone.commit, repoId });
    } catch (err) {
      // importCourse already wrote its own failed import_runs row (see
      // import.ts's startImportRun/finishImportRun) — writing a second one
      // here would double-count this attempt in the history list.
      const problems = problemsFromError(err);
      onEvent({ stage: 'failed', problems });
      return { ok: false, problems };
    }

    // Best-effort: last_synced_at is informational (design §7). The import
    // itself already committed and already has its own import_runs
    // 'success' row, so a failure here must never be reported as an import
    // failure.
    try {
      await markRepoSynced(client, repoId);
    } catch {
      // Nothing to do — see comment above.
    }

    onEvent({
      stage: 'done',
      importRunId: result.importRunId,
      slug: result.slug,
      commitSha: clone.commit,
      counts: result.counts,
    });
    return { ok: true, importRunId: result.importRunId, slug: result.slug, commitSha: clone.commit, counts: result.counts };
  } catch (err) {
    // A catch-all for anything unexpected above that isn't one of the
    // specific business failures already handled (e.g. upsertContentRepo or
    // validateCourseDir itself throwing on a DB/filesystem error) — this is
    // what makes "never throws" (see the doc comment) actually true rather
    // than aspirational.
    const problems = problemsFromError(err);
    let importRunId: string | undefined;
    try {
      importRunId = await recordPreImportFailure(client, { repoId, slug: null, commit: clone.commit, problems });
    } catch {
      // The connection itself is what broke; report the original failure
      // with no run id rather than mask it with a second one.
    }
    onEvent({ stage: 'failed', problems, importRunId });
    return { ok: false, problems };
  } finally {
    await removeClone(clone.dir);
  }
}
