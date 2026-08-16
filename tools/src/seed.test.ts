import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const run = promisify(execFile);
const { Pool } = pg;

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is not set — required to run seed.test.ts');
}

const here = path.dirname(fileURLToPath(import.meta.url));
const migrateCli = path.join(here, 'migrate.ts');
const seedCli = path.join(here, 'seed.ts');

// The CLIs read DATABASE_URL. Point it at the test database so we exercise the
// real binaries rather than a reimplementation of them.
const cliEnv = { ...process.env, DATABASE_URL: connectionString };

/**
 * Runs the actual seed CLI as a subprocess.
 *
 * This matters: an earlier version of this file inlined its own INSERT against a
 * table it created itself, so it passed without ever executing seed.ts. A test
 * that would still pass if the code under test were deleted is not a test.
 */
async function seed(file: string, slug?: string): Promise<string> {
  const args = slug ? [seedCli, file, '--slug', slug] : [seedCli, file];
  const { stdout } = await run(process.execPath, args, { env: cliEnv });
  return stdout.trim();
}

describe.sequential('seed CLI', () => {
  const pool = new Pool({ connectionString });
  let tmp: string;

  beforeAll(async () => {
    // Real schema, applied by the real migration runner.
    await run(process.execPath, [migrateCli], { env: cliEnv });
    tmp = await mkdtemp(path.join(tmpdir(), 'seed-test-'));
  });

  afterAll(async () => {
    await pool.query(`delete from courses where slug = 'scratch'`);
    await pool.end();
    await rm(tmp, { recursive: true, force: true });
  });

  it('inserts a lesson attached to a real course and module', async () => {
    const file = path.join(tmp, 'hello-world.md');
    await writeFile(
      file,
      ['# Hello World', '', 'This is a prose block.', '', '```typescript', 'const x = 42;', '```', '', 'Another prose block.', ''].join('\n'),
    );

    const stdout = await seed(file);
    expect(stdout).toContain('hello-world');
    expect(stdout).toContain('Hello World');

    const { rows } = await pool.query(
      `select l.slug, l.lesson_key, l.kind, l.blocks, l.content_hash,
              c.slug as course_slug, m.key as module_key
         from lessons l
         join modules m on m.id = l.module_id
         join courses c on c.id = l.course_id
        where l.slug = $1`,
      ['hello-world'],
    );

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.course_slug).toBe('scratch');
    expect(row.module_key).toBe('scratch');
    expect(row.kind).toBe('lesson');
    expect(row.content_hash).toHaveLength(64); // sha256 hex
    expect(row.blocks).toHaveLength(3);
    expect(row.blocks[0].type).toBe('prose');
    expect(row.blocks[1].type).toBe('code');
    expect(row.blocks[1].lang).toBe('typescript');
    expect(row.blocks[2].type).toBe('prose');
  });

  it('upserts rather than duplicating when the same slug is seeded twice', async () => {
    const first = path.join(tmp, 'repeat.md');
    await writeFile(first, '# Version One\n\nContent one.\n');
    await seed(first, 'repeat-me');

    const before = await pool.query(`select title, updated_at from lessons where slug = 'repeat-me'`);
    expect(before.rowCount).toBe(1);

    const second = path.join(tmp, 'repeat2.md');
    await writeFile(second, "# Version Two\n\nContent two.\n\n```js\nconsole.log('update');\n```\n");
    await seed(second, 'repeat-me');

    const after = await pool.query(
      `select title, blocks, updated_at from lessons where slug = 'repeat-me'`,
    );
    expect(after.rowCount).toBe(1); // updated, not duplicated
    expect(after.rows[0].title).toBe('Version Two');
    expect(after.rows[0].blocks).toHaveLength(2);
    expect(new Date(after.rows[0].updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(before.rows[0].updated_at).getTime(),
    );
  });

  it('exits non-zero for a file that does not exist', async () => {
    await expect(seed(path.join(tmp, 'nope-not-here.md'))).rejects.toThrow();
  });
});
