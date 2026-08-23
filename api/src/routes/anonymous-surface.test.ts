import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../index.ts';
import { setPool, closePool } from '../db.ts';
import { ANONYMOUS_ACTOR } from '../policy/can.ts';

/**
 * WHAT AN UNAUTHENTICATED CALLER CAN REACH, over the WHOLE route table.
 *
 * CLAUDE.md rule 2 says every handler takes an `actor` and calls `can()`, and
 * that a handler skipping it "is a bug, not a shortcut". Nothing enforced
 * that. There are forty-five hand-written anonymous-access assertions across
 * the route tests, which is good discipline and covers the routes somebody
 * remembered — a new route added without one is simply unguarded, and the
 * suite stays green.
 *
 * So this enumerates the routes from Fastify itself rather than from a list
 * written here, and asks each one the same question with no session. A route
 * that appears tomorrow is in this test the moment it is registered.
 *
 * TWO ASSERTIONS, and the second is the one with teeth:
 *
 *   1. No route answers 5xx. A crash on unauthenticated input is a different
 *      bug from a leak and this is the only place that would notice it.
 *   2. The set of routes that answer 2xx anonymously is EXACTLY the set named
 *      below. Not "no more than" — exactly, so removing a public route is
 *      also a diff someone has to look at.
 *
 * The second is deliberately a set comparison rather than a per-route check.
 * The failure message then names precisely what changed, and the list itself
 * becomes the documented unauthenticated surface of the instance — which is
 * a thing worth being able to read in one place.
 */

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is not set — required to run anonymous-surface.test.ts');
}

const { Pool } = pg;
const pool = new Pool({ connectionString });

/**
 * Placeholders for path parameters. Every one names something that does not
 * exist: the question is whether the route refuses the CALLER, and a real id
 * would let a route pass by 404-ing on the data instead.
 */
const PARAMETERS: Record<string, string> = {
  ':courseSlug': 'no-such-course-anon-probe',
  ':lessonSlug': 'no-such-lesson-anon-probe',
  ':userId': randomUUID(),
  ':handle': 'nobody-anon-probe',
  ':badgeSlug': 'no-such-badge-anon-probe',
  ':inviteId': randomUUID(),
};

/**
 * THE UNAUTHENTICATED SURFACE OF THIS INSTANCE.
 *
 * Every entry corresponds to something in `PUBLIC_ACTIONS`
 * (api/src/policy/can.ts) or to the auth endpoints, which cannot require a
 * session by definition. Reaching one is not the same as being shown
 * anything — the profile routes answer through a deny-by-default allowlist
 * serializer, and the invite routes are gated by a 256-bit token rather than
 * by a role.
 */
const PUBLIC_2XX: ReadonlySet<string> = new Set([
  // Liveness. Returns no data about anything.
  'GET /api/v1/health',
  // Whether this instance has been claimed (design §5.2). One bit, and the
  // 410 on the bootstrap route already reveals the same bit.
  'GET /api/v1/setup',
  // Logging out without a session. 204 rather than a refusal because the
  // request has been honoured either way — the caller is not signed in, which
  // is what they asked for — and because answering 401 here would make the
  // endpoint report whether a cookie was valid. It clears cookies and reads
  // nothing.
  //
  // `POST /api/v1/auth/logout-all` is deliberately NOT here: revoking every
  // session of an account requires knowing whose, so it refuses.
  'POST /api/v1/auth/logout',
]);

/** Parses `printRoutes` output into concrete (method, path) pairs. */
function parseRouteTree(tree: string): { method: string; path: string }[] {
  const routes: { method: string; path: string }[] = [];
  const prefixAtDepth: string[] = [];

  for (const line of tree.split('\n')) {
    // The indent class lists the tree-drawing characters EXPLICITLY. It was
    // `[^a-zA-Z/]*`, which is greedy and also matches a hyphen — so Fastify's
    // `-all` child of `/logout` had its leading dash eaten and the path came
    // out as `/api/v1/auth/logoutall`. That route was then probed at an
    // address nothing serves, and a 404 sits inside the allowed set, so the
    // assertion passed while covering nothing.
    const match = /^([\s│├└─]*)(\S+) \(([^)]+)\)\s*$/.exec(line);
    if (!match) continue;
    const [, indent, segment, methods] = match;
    // Fastify draws four characters of tree per level, and a child's label is
    // CONCATENATED to its parent's — `/submission` + `s/:userId` is
    // `/submissions/:userId`, not two path segments.
    const depth = Math.floor((indent ?? '').length / 4);
    prefixAtDepth[depth] = (depth === 0 ? '' : (prefixAtDepth[depth - 1] ?? '')) + segment!;
    const path = prefixAtDepth[depth]!;

    for (const method of methods!.split(',').map((m) => m.trim())) {
      // HEAD is generated from GET and exercises the same handler.
      if (method === 'HEAD') continue;
      routes.push({ method, path });
    }
  }
  return routes;
}

function concrete(path: string): string {
  let out = path;
  for (const [token, value] of Object.entries(PARAMETERS)) {
    out = out.replaceAll(token, value);
  }
  return out;
}

interface Probe {
  key: string;
  status: number;
  body: string;
}

let probes: Probe[] = [];

// ---------------------------------------------------------------------------
// MIGRATIONS, APPLIED HERE RATHER THAN ASSUMED.
//
// CI runs `npm run migrate` before the suite, so this file passed without a
// bootstrap of its own. It was relying on file ORDER: vitest runs with
// `fileParallelism: false`, and `tools/src/migrate.test.ts` drops `courses`,
// `lessons`, `modules`, `tracks`, `import_runs`, `content_repos` and
// `schema_migrations` in its `afterAll` so that it can re-run. Anything
// scheduled after it meets an empty schema.
//
// Adding two unrelated test files was enough to reshuffle that order, and
// every course-scoped probe here began answering 500 ("relation \"courses\"
// does not exist") instead of the 4xx this file asserts. Reproduce with:
//
//   npx vitest run tools/src/migrate.test.ts api/src/routes/anonymous-surface.test.ts
//
// Every other DB-touching file in this repo owns a copy of this bootstrap.
// This one was the exception, and CLAUDE.md already says why it should not
// be: "Test databases: apply migrations first."
// ---------------------------------------------------------------------------
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

async function applyMigrations(): Promise<void> {
  await pool.query(`
    create table if not exists schema_migrations (
      version     text primary key,
      applied_at  timestamptz not null default now()
    )
  `);

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await pool.query<{ version: string }>('select version from schema_migrations');
  const applied = new Set(rows.map((r) => r.version));

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;

    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    try {
      await pool.query(sql);
      await pool.query('insert into schema_migrations (version) values ($1) on conflict do nothing', [version]);
    } catch (err) {
      if ((err as { code?: string }).code !== '42P07' /* duplicate_table */) throw err;
    }
  }
}

describe('the unauthenticated surface of the whole API', () => {
  beforeAll(async () => {
    await applyMigrations();
    setPool(pool);
    const server = await buildServer({ actor: ANONYMOUS_ACTOR });
    try {
      const routes = parseRouteTree(server.printRoutes({ commonPrefix: false }));

      // If the parse breaks, every assertion below silently passes on an
      // empty list. This is the guard against that.
      expect(routes.length, 'parsed no routes out of printRoutes').toBeGreaterThan(30);

      probes = [];
      for (const { method, path } of routes) {
        const response = await server.inject({
          method: method as 'GET',
          url: concrete(path),
          ...(method === 'GET' || method === 'DELETE'
            ? {}
            : { headers: { 'content-type': 'application/json' }, payload: {} }),
        });
        probes.push({ key: `${method} ${path}`, status: response.statusCode, body: response.body.slice(0, 200) });
      }
    } finally {
      await server.close();
    }
  }, 120_000);

  afterAll(async () => {
    await closePool();
  });

  it('reached every registered route', () => {
    expect(probes.length).toBeGreaterThan(30);
  });

  it('never answers 5xx to an unauthenticated caller', () => {
    // A crash on input from someone with no session is a different bug from a
    // leak, and nothing else in the suite would see it.
    const crashed = probes.filter((p) => p.status >= 500).map((p) => `${p.key} -> ${p.status} ${p.body}`);
    expect(crashed).toEqual([]);
  });

  it('answers 2xx to exactly the routes that are meant to be public', () => {
    const succeeded = probes.filter((p) => p.status >= 200 && p.status < 300).map((p) => p.key);
    expect(new Set(succeeded), 'the unauthenticated surface of this instance has changed').toEqual(PUBLIC_2XX);
  });

  it('refuses everything else with a 4xx that is about authorization or absence', () => {
    for (const probe of probes) {
      if (PUBLIC_2XX.has(probe.key)) continue;
      expect([400, 401, 403, 404, 405, 409, 410, 413, 415, 429], `${probe.key} answered ${probe.status}`).toContain(
        probe.status,
      );
    }
  });

  it('never leaks an email address to an unauthenticated caller (Gate 12, across every route)', () => {
    // Gate 12 was signed off by reading the profile serializer. This asks the
    // same question of every response the whole API gives a stranger.
    for (const probe of probes) {
      expect(probe.body, `${probe.key} put an email address in an anonymous response`).not.toMatch(
        /[\w.+-]+@[\w-]+\.[\w.]+/,
      );
    }
  });
});
