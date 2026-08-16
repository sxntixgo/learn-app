import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { buildServer } from '../index.ts';
import { setPool, closePool } from '../db.ts';

const { Pool } = pg;

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is not set — required to run lessons.test.ts');
}

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

const pool = new Pool({ connectionString });

// Applies db/migrations/*.sql that aren't already recorded in
// schema_migrations. Deliberately not importing tools/src/migrate.ts here:
// @learn/tools depends on @learn/api, not the other way around, so pulling
// the runner into an api test would invert that dependency. This mirrors
// the same technique (real migration files, schema_migrations bookkeeping)
// tools/src/migrate.test.ts uses, scoped locally to this test file.
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
      // Another concurrently-running test file may have created the table
      // first; that's fine as long as it exists.
      const code = (err as { code?: string }).code;
      if (code !== '42P07' /* duplicate_table */) throw err;
    }
  }
}

const TEST_SLUG = 'lessons-route-test-lesson';
const TEST_TITLE = 'Route Test Lesson';
const TEST_BLOCKS = [
  { type: 'prose', html: '<p>Hello</p>' },
  { type: 'code', lang: 'js', source: 'const x = 1;' },
];

describe('GET /api/v1/lessons/:slug', () => {
  beforeAll(async () => {
    await applyMigrations();
    setPool(pool);

    await pool.query(
      `insert into lessons (slug, title, blocks) values ($1, $2, $3)
       on conflict (slug) do update set title = $2, blocks = $3, updated_at = now()`,
      [TEST_SLUG, TEST_TITLE, JSON.stringify(TEST_BLOCKS)],
    );
  });

  afterAll(async () => {
    await pool.query('delete from lessons where slug = $1', [TEST_SLUG]);
    await closePool();
  });

  it('returns 200 with exactly {slug, title, blocks} and well-shaped blocks', async () => {
    const fastify = await buildServer();
    const response = await fastify.inject({ method: 'GET', url: `/api/v1/lessons/${TEST_SLUG}` });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload) as { slug: string; title: string; blocks: unknown[] };

    expect(Object.keys(body).sort()).toEqual(['blocks', 'slug', 'title']);
    expect(body.slug).toBe(TEST_SLUG);
    expect(body.title).toBe(TEST_TITLE);
    expect(Array.isArray(body.blocks)).toBe(true);
    expect(body.blocks).toHaveLength(2);

    for (const block of body.blocks as Array<Record<string, unknown>>) {
      expect(['prose', 'code']).toContain(block.type);
      if (block.type === 'prose') {
        expect(typeof block.html).toBe('string');
      } else {
        expect(typeof block.source).toBe('string');
      }
    }

    await fastify.close();
  });

  it('returns 404 with a message body for an unknown slug', async () => {
    const fastify = await buildServer();
    const response = await fastify.inject({ method: 'GET', url: '/api/v1/lessons/no-such-lesson-xyz' });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.payload) as { message: string };
    expect(typeof body.message).toBe('string');
    expect(body.message.length).toBeGreaterThan(0);

    await fastify.close();
  });

  it('returns 403 with a message body when the injected policy denies access', async () => {
    const fastify = await buildServer({ can: () => false });
    const response = await fastify.inject({ method: 'GET', url: `/api/v1/lessons/${TEST_SLUG}` });

    expect(response.statusCode).toBe(403);
    const body = JSON.parse(response.payload) as { message: string };
    expect(typeof body.message).toBe('string');
    expect(body.message.length).toBeGreaterThan(0);

    await fastify.close();
  });

  it('calls can() with the "lesson:read" action and the lesson as resource — the seam guard', async () => {
    const canSpy = vi.fn().mockReturnValue(true);
    const fastify = await buildServer({ can: canSpy });

    const response = await fastify.inject({ method: 'GET', url: `/api/v1/lessons/${TEST_SLUG}` });

    expect(response.statusCode).toBe(200);
    expect(canSpy).toHaveBeenCalledTimes(1);
    const [actorArg, actionArg, resourceArg] = canSpy.mock.calls[0] as [unknown, unknown, unknown];
    expect(actionArg).toBe('lesson:read');
    expect(actorArg).toBeTruthy();
    expect(resourceArg).toMatchObject({ slug: TEST_SLUG });

    await fastify.close();
  });
});
