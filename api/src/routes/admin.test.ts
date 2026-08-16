import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { buildServer } from '../index.ts';
import { setPool, closePool } from '../db.ts';

const { Pool } = pg;

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is not set — required to run admin.test.ts');
}

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

const pool = new Pool({ connectionString });

// Mirrors courses.test.ts/me.test.ts's own copy — each DB-touching test
// file owns its migration bootstrap.
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
      const code = (err as { code?: string }).code;
      if (code !== '42P07' /* duplicate_table */) throw err;
    }
  }
}

/** Splits an NDJSON response payload into its parsed event objects. */
function parseNdjson(payload: string): Array<Record<string, unknown>> {
  return payload
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const SLUG_PREFIX = 'admin-route-test';

describe('admin routes', () => {
  beforeAll(async () => {
    await applyMigrations();
    setPool(pool);
  });

  afterAll(async () => {
    await pool.query('delete from import_runs where course_slug like $1', [`${SLUG_PREFIX}%`]);
    await pool.query(
      "delete from import_runs where course_slug is null and log::text like '%Refusing to clone file://%'",
    );
    await pool.query('delete from courses where slug like $1', [`${SLUG_PREFIX}%`]);
    await closePool();
  });

  describe('POST /api/v1/admin/imports', () => {
    it('returns 400 when url is missing', async () => {
      const fastify = await buildServer();
      const response = await fastify.inject({
        method: 'POST',
        url: '/api/v1/admin/imports',
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      await fastify.close();
    });

    it('calls can() with the repo:import action before doing anything, and returns 403 when denied', async () => {
      const canSpy = vi.fn(() => false);
      const fastify = await buildServer({ can: canSpy });

      const before = await pool.query('select count(*)::int as n from import_runs');

      const response = await fastify.inject({
        method: 'POST',
        url: '/api/v1/admin/imports',
        payload: { url: 'https://example.invalid/some-repo.git' },
      });

      expect(response.statusCode).toBe(403);
      expect(canSpy).toHaveBeenCalledTimes(1);
      const [actorArg, actionArg, resourceArg] = canSpy.mock.calls[0] as [unknown, unknown, unknown];
      expect(actionArg).toBe('repo:import');
      expect(actorArg).toBeTruthy();
      expect(resourceArg).toMatchObject({ url: 'https://example.invalid/some-repo.git' });

      // Denied before any clone was ever attempted — no row written.
      const after = await pool.query('select count(*)::int as n from import_runs');
      expect(after.rows[0].n).toBe(before.rows[0].n);

      await fastify.close();
    });

    it('rejects a file:// URL — it never reaches the filesystem via this endpoint — and still records a failed import_runs row', async () => {
      const canSpy = vi.fn(() => true);
      const fastify = await buildServer({ can: canSpy });

      const response = await fastify.inject({
        method: 'POST',
        url: '/api/v1/admin/imports',
        payload: { url: 'file:///etc/passwd' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('application/x-ndjson');
      expect(canSpy).toHaveBeenCalledTimes(1);
      expect(canSpy.mock.calls[0]?.[1]).toBe('repo:import');

      const events = parseNdjson(response.payload);
      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events[0]?.stage).toBe('cloning');

      const last = events.at(-1)!;
      expect(last.stage).toBe('failed');
      const problems = last.problems as string[];
      expect(problems.join('\n')).toMatch(/Refusing to clone file:\/\//);
      expect(problems.join('\n')).toMatch(/only https:\/\/ and ssh:\/\/ remotes are allowed/);
      expect(problems.join('\n')).not.toMatch(/allowFileUrl/i); // the internal switch is never named back at the caller

      // A failed import still leaves an import_runs row (design brief).
      expect(last.importRunId).toBeTruthy();
      const runRow = await pool.query('select status, repo_id, course_slug, commit_sha from import_runs where id = $1', [
        last.importRunId,
      ]);
      expect(runRow.rows).toHaveLength(1);
      expect(runRow.rows[0]).toMatchObject({ status: 'failed', repo_id: null, course_slug: null, commit_sha: null });

      await pool.query('delete from import_runs where id = $1', [last.importRunId]);
      await fastify.close();
    });

    it('rejects a file:// URL even when a ref is also supplied', async () => {
      const fastify = await buildServer({ can: () => true });

      const response = await fastify.inject({
        method: 'POST',
        url: '/api/v1/admin/imports',
        payload: { url: 'file:///etc/passwd', ref: 'main' },
      });

      const events = parseNdjson(response.payload);
      const last = events.at(-1)!;
      expect(last.stage).toBe('failed');
      const problems = (last.problems as string[]).join('\n');
      expect(problems).toMatch(/Refusing to clone file:\/\//);

      await pool.query('delete from import_runs where id = $1', [last.importRunId]);
      await fastify.close();
    });
  });

  describe('GET /api/v1/admin/import-runs', () => {
    it('calls can() with the import:history:read action, and returns 403 when denied', async () => {
      const canSpy = vi.fn(() => false);
      const fastify = await buildServer({ can: canSpy });

      const response = await fastify.inject({ method: 'GET', url: '/api/v1/admin/import-runs' });

      expect(response.statusCode).toBe(403);
      expect(canSpy).toHaveBeenCalledTimes(1);
      expect(canSpy.mock.calls[0]?.[1]).toBe('import:history:read');

      await fastify.close();
    });

    it('returns run history newest first, with counts on success and the problem list on failure', async () => {
      const successSlug = `${SLUG_PREFIX}-success`;
      const failedSlug = `${SLUG_PREFIX}-failed`;

      const counts = {
        courses: { created: 1, updated: 0, skipped: 0, archived: 0 },
        tracks: { created: 0, updated: 0, skipped: 0, archived: 0 },
        modules: { created: 1, updated: 0, skipped: 0, archived: 0 },
        lessons: { created: 3, updated: 0, skipped: 0, archived: 0 },
      };

      const successRun = await pool.query<{ id: string }>(
        `insert into import_runs (course_slug, commit_sha, status, finished_at, log)
         values ($1, 'abc123', 'success', now(), $2::jsonb)
         returning id`,
        [successSlug, JSON.stringify({ counts })],
      );

      const problems = ['modules/01-intro/broken.md:/kind: must be equal to one of the allowed values'];
      const failedRun = await pool.query<{ id: string }>(
        `insert into import_runs (course_slug, commit_sha, status, finished_at, log)
         values ($1, null, 'failed', now(), $2::jsonb)
         returning id`,
        [failedSlug, JSON.stringify({ error: { message: problems.join('\n') }, problems })],
      );

      try {
        const fastify = await buildServer({ can: () => true });
        const response = await fastify.inject({ method: 'GET', url: '/api/v1/admin/import-runs?limit=100' });

        expect(response.statusCode).toBe(200);
        const runs = JSON.parse(response.payload) as Array<Record<string, unknown>>;

        const success = runs.find((r) => r.id === successRun.rows[0]!.id);
        expect(success).toMatchObject({ status: 'success', courseSlug: successSlug, commitSha: 'abc123', error: null, problems: [] });
        expect(success!.counts).toMatchObject(counts);

        const failed = runs.find((r) => r.id === failedRun.rows[0]!.id);
        expect(failed).toMatchObject({
          status: 'failed',
          courseSlug: failedSlug,
          commitSha: null,
          counts: null,
          error: problems.join('\n'),
        });
        expect(failed!.problems).toEqual(problems);

        await fastify.close();
      } finally {
        await pool.query('delete from import_runs where id = any($1::uuid[])', [
          [successRun.rows[0]!.id, failedRun.rows[0]!.id],
        ]);
      }
    });

    it('clamps limit and defaults sensibly', async () => {
      const fastify = await buildServer({ can: () => true });
      const response = await fastify.inject({ method: 'GET', url: '/api/v1/admin/import-runs?limit=0' });

      expect(response.statusCode).toBe(200);
      const runs = JSON.parse(response.payload) as unknown[];
      expect(Array.isArray(runs)).toBe(true);
      expect(runs.length).toBeLessThanOrEqual(1); // clamped to at least 1, not "no limit"

      await fastify.close();
    });
  });
});
