import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../index.ts';
import { setPool, closePool } from '../db.ts';
import { ANONYMOUS_ACTOR } from '../policy/can.ts';

/**
 * THE CONTRACT AND THE SERVER DESCRIBE THE SAME API.
 *
 * CLAUDE.md rule 3 says `openapi/openapi.yaml` is the contract and the path
 * must be declared BEFORE the route is implemented. It also says, plainly,
 * why that keeps failing:
 *
 *   "`gen:api:check` catches a stale generated file, not a missing path.
 *    Nothing automatically detects a route that was never declared, so it is
 *    on you."
 *
 * It has drifted three times, each one recorded in that file: `annotations`
 * on CodeBlock, live since Phase 2 and undeclared; the four `/auth/*`
 * endpoints, so the contract claimed this API had no authentication at all;
 * and the submission routes. Each time the web side worked around it with a
 * hand-written type, which is the symptom rather than the cause.
 *
 * This is the missing check. It compares the routes Fastify actually
 * registered against the paths the contract declares, in both directions —
 * an undeclared route is drift, and so is a declared path nobody serves,
 * which is a promise to a client that will 404.
 */
const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is not set — required to run contract-coverage.test.ts');
}

const { Pool } = pg;
const pool = new Pool({ connectionString });

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Fastify writes `:slug`; OpenAPI writes `{slug}`. Compare in one dialect. */
function normalise(fastifyPath: string): string {
  return fastifyPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

/** Parses `printRoutes` output into `METHOD /path` strings. */
function registeredRoutes(tree: string): Set<string> {
  const routes = new Set<string>();
  const prefixAtDepth: string[] = [];

  for (const line of tree.split('\n')) {
    const match = /^([\s│├└─]*)(\S+) \(([^)]+)\)\s*$/.exec(line);
    if (!match) continue;
    const [, indent, segment, methods] = match;
    const depth = Math.floor((indent ?? '').length / 4);
    prefixAtDepth[depth] = (depth === 0 ? '' : (prefixAtDepth[depth - 1] ?? '')) + segment!;

    for (const method of methods!.split(',').map((m) => m.trim())) {
      // HEAD is generated from GET; OPTIONS is CORS plumbing. Neither is a
      // thing a contract describes.
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      routes.add(`${method} ${normalise(prefixAtDepth[depth]!)}`);
    }
  }
  return routes;
}

/**
 * Parses `METHOD /path` out of the contract.
 *
 * A deliberately small YAML reader rather than a parser dependency: only two
 * indentation levels matter — a path is two spaces in and ends with a colon,
 * and its verbs are four spaces in.
 */
function declaredRoutes(yaml: string): Set<string> {
  const declared = new Set<string>();
  const body = yaml.slice(yaml.indexOf('\npaths:'), yaml.indexOf('\ncomponents:'));
  let currentPath: string | null = null;

  for (const line of body.split('\n')) {
    const pathMatch = /^ {2}(\/\S*):\s*$/.exec(line);
    if (pathMatch) {
      currentPath = pathMatch[1]!;
      continue;
    }
    const verbMatch = /^ {4}(get|post|put|patch|delete):\s*$/.exec(line);
    if (verbMatch && currentPath) {
      declared.add(`${verbMatch[1]!.toUpperCase()} ${currentPath}`);
    }
  }
  return declared;
}

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

let registered: Set<string>;
let declared: Set<string>;

describe('every route is in the contract, and every contract path is a route', () => {
  beforeAll(async () => {
    await applyMigrations();
    setPool(pool);
    const server = await buildServer({ actor: ANONYMOUS_ACTOR });
    try {
      registered = registeredRoutes(server.printRoutes({ commonPrefix: false }));
    } finally {
      await server.close();
    }
    declared = declaredRoutes(readFileSync(path.join(repoRoot, 'openapi', 'openapi.yaml'), 'utf8'));
  }, 60_000);

  afterAll(async () => {
    await closePool();
  });

  it('parsed both sides — otherwise the comparisons below are vacuous', () => {
    // Two empty sets match each other perfectly. This is the guard against a
    // green run that checked nothing, which is the only way a test like this
    // fails safe in the wrong direction.
    expect(registered.size, 'parsed no routes from printRoutes').toBeGreaterThan(30);
    expect(declared.size, 'parsed no paths from openapi.yaml').toBeGreaterThan(30);
  });

  it('declares every route the server serves', () => {
    // The drift CLAUDE.md records three times: a route goes live, the
    // contract never learns about it, and the web side papers over the gap
    // with a hand-written type.
    const undeclared = [...registered].filter((route) => !declared.has(route)).sort();
    expect(undeclared, 'these routes exist but openapi.yaml does not describe them').toEqual([]);
  });

  it('serves every path the contract declares', () => {
    // The opposite drift, and the one a client feels: the contract promises
    // an endpoint, the generated types offer it, and calling it 404s.
    const unserved = [...declared].filter((route) => !registered.has(route)).sort();
    expect(unserved, 'openapi.yaml describes these but no route serves them').toEqual([]);
  });
});
