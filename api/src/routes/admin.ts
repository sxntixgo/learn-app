import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { getPool } from '../db.ts';
import type { Actor } from '../policy/can.ts';
import { can as defaultCan, DEV_ACTOR } from '../policy/can.ts';
import type { ImportProgressEvent } from '../content/run-import.ts';
import { runImportPipeline } from '../content/run-import.ts';

// =============================================================================
// UNAUTHENTICATED UNTIL PHASE 6.
//
// There is no session and no login anywhere in this codebase yet — `actor`
// below is DEV_ACTOR, a hardcoded stand-in, exactly like every other route
// registered in api/src/index.ts today. That is acceptable ONLY because the
// app is LAN-only until Gate 6 (design §5.2). It is worth being explicit
// about it here specifically because, unlike a course GET, this screen
// triggers a real network fetch (`git clone` of a caller-supplied URL) and
// real database writes.
//
// The two actions below ('repo:import', 'import:history:read') are
// deliberately distinct from every other action string in this codebase, so
// Phase 6 can gate this screen precisely by populating `actor` from a real
// session and tightening `can()` — no handler code changes, per CLAUDE.md
// rule 2.
// =============================================================================

export interface AdminRouteDeps {
  // Injectable policy function (CLAUDE.md rule 2), same seam as every other
  // route module.
  can?: typeof defaultCan;
  actor?: Actor;
}

interface AdminImportBody {
  url?: unknown;
  ref?: unknown;
}

interface ImportRunRow {
  id: string;
  repo_url: string | null;
  course_slug: string | null;
  commit_sha: string | null;
  status: string;
  started_at: Date;
  finished_at: Date | null;
  log: unknown;
}

interface ImportRunLog {
  counts?: unknown;
  error?: { message?: string };
  problems?: string[];
}

const DEFAULT_HISTORY_LIMIT = 20;
const MIN_HISTORY_LIMIT = 1;
const MAX_HISTORY_LIMIT = 100;

/** Parses and clamps the `?limit=` query param, same shape as me.ts's activity feed. */
function clampHistoryLimit(raw: unknown): number {
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_HISTORY_LIMIT;
  return Math.min(MAX_HISTORY_LIMIT, Math.max(MIN_HISTORY_LIMIT, Math.floor(n)));
}

function writeEvent(stream: PassThrough, event: ImportProgressEvent): void {
  // Newline-delimited JSON (design brief: "simplest and adequate" for a
  // synchronous, seconds-long import — see design §8's "no job queue").
  // One JSON object per line; the client splits on '\n' as lines arrive.
  stream.write(`${JSON.stringify(event)}\n`);
}

/** Registers the admin content-import routes: streamed import + run history. */
export function registerAdminRoutes(fastify: FastifyInstance, deps: AdminRouteDeps = {}): void {
  const can = deps.can ?? defaultCan;
  const actor = deps.actor ?? DEV_ACTOR;

  fastify.post<{ Body: AdminImportBody }>('/api/v1/admin/imports', async (request, reply) => {
    const body = request.body ?? {};
    const { url, ref } = body;

    if (typeof url !== 'string' || url.trim() === '') {
      return reply.code(400).send({ message: 'url is required and must be a non-empty string.' });
    }
    if (ref !== undefined && typeof ref !== 'string') {
      return reply.code(400).send({ message: 'ref must be a string when provided.' });
    }

    if (!can(actor, 'repo:import', { url, ref })) {
      return reply.code(403).send({ message: 'Forbidden' });
    }

    const stream = new PassThrough();
    reply.header('Content-Type', 'application/x-ndjson');
    reply.header('Cache-Control', 'no-cache');
    // Not awaited/returned: this schedules the stream to start piping to the
    // response immediately. The handler keeps running below to feed it —
    // returning here (as every other route in this codebase does) would end
    // the function before a single progress event was ever written.
    reply.send(stream);

    const client = await getPool().connect();
    try {
      // allowFileUrl is NEVER passed here. `url` is attacker-influenced
      // input straight from the request body — see clone.ts's
      // CloneOptions.allowFileUrl and run-import.ts's RunImportArgs for why
      // that switch exists and why it is a TypeScript argument, not
      // anything a request body could ever set. Omitting it is what keeps a
      // `file://` URL posted here from ever reaching the filesystem.
      await runImportPipeline(client, { url, ref }, (event) => writeEvent(stream, event));
    } finally {
      client.release();
      stream.end();
    }
  });

  fastify.get<{ Querystring: { limit?: string } }>('/api/v1/admin/import-runs', async (request, reply) => {
    if (!can(actor, 'import:history:read')) {
      return reply.code(403).send({ message: 'Forbidden' });
    }

    const limit = clampHistoryLimit(request.query.limit);

    const result = await getPool().query<ImportRunRow>(
      `select ir.id, cr.url as repo_url, ir.course_slug, ir.commit_sha, ir.status,
              ir.started_at, ir.finished_at, ir.log
         from import_runs ir
         left join content_repos cr on cr.id = ir.repo_id
        order by ir.started_at desc
        limit $1`,
      [limit],
    );

    const runs = result.rows.map((row) => {
      const log = (row.log ?? {}) as ImportRunLog;
      // Same problem list a failed import returns over the stream (design
      // §8: "error quality is the authoring experience") — importCourse's
      // own failure rows only carry `error.message` (possibly multi-line),
      // so that is split the same way run-import.ts's problemsFromError
      // does, rather than showing the admin one giant unsplit line.
      const problems = Array.isArray(log.problems)
        ? log.problems
        : (log.error?.message?.split('\n') ?? []);

      return {
        id: row.id,
        status: row.status,
        repoUrl: row.repo_url,
        courseSlug: row.course_slug,
        commitSha: row.commit_sha,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        counts: log.counts ?? null,
        error: log.error?.message ?? null,
        problems,
      };
    });

    return reply.code(200).send(runs);
  });
}
