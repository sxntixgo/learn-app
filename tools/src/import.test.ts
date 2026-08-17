import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const run = promisify(execFile);
const { Pool } = pg;

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is not set — required to run import.test.ts');
}

const here = path.dirname(fileURLToPath(import.meta.url));
const migrateCli = path.join(here, 'migrate.ts');
const importCliPath = path.join(here, 'import.ts');
const fixtures = path.resolve(here, '../test-fixtures');

const cliEnv = { ...process.env, DATABASE_URL: connectionString };

/**
 * Runs the actual import CLI as a subprocess, so this exercises the real
 * binary (argument handling, exit code, printed summary) rather than a
 * reimplementation of it.
 */
async function importCli(dir: string): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [importCliPath, dir], { env: cliEnv });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
}

describe.sequential('import CLI', () => {
  const pool = new Pool({ connectionString });

  beforeAll(async () => {
    await run(process.execPath, [migrateCli], { env: cliEnv });
  });

  afterAll(async () => {
    await pool.query(
      `delete from import_runs where course_slug in ('fixture-course', 'unknown-track-course', 'quiz-fixture-course')`,
    );
    await pool.query(`delete from courses where slug in ('fixture-course', 'unknown-track-course', 'quiz-fixture-course')`);
    await pool.end();
  });

  it('imports the valid fixture and prints the counts summary', async () => {
    const { stdout, code } = await importCli(path.join(fixtures, 'valid-course'));

    expect(code).toBe(0);
    expect(stdout).toContain('fixture-course: import ok');
    expect(stdout).toMatch(/lessons\s+2 created/);

    const { rows } = await pool.query(
      `select count(*)::int as lessons from lessons l
         join courses c on c.id = l.course_id where c.slug = 'fixture-course'`,
    );
    expect(rows[0].lessons).toBe(2);
  });

  it('reports 0 created and 0 updated on a second import of unchanged content', async () => {
    const { stdout, code } = await importCli(path.join(fixtures, 'valid-course'));

    expect(code).toBe(0);
    expect(stdout).toMatch(/lessons\s+0 created,\s+0 updated,\s+2 skipped,\s+0 archived/);
  });

  it('imports a fixture course with a quiz block successfully (design §6.3, Task A)', async () => {
    const { stdout, code } = await importCli(path.join(fixtures, 'quiz-course'));

    expect(code).toBe(0);
    expect(stdout).toContain('quiz-fixture-course: import ok');
    expect(stdout).toMatch(/lessons\s+1 created/);

    const { rows } = await pool.query<{ kind: string; blocks: unknown }>(
      `select l.kind, l.blocks from lessons l
         join courses c on c.id = l.course_id where c.slug = 'quiz-fixture-course'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('quiz');
    const blocks = rows[0]!.blocks as Array<{ type: string; pass?: number; questions?: unknown[] }>;
    const quizBlock = blocks.find((b) => b.type === 'quiz')!;
    expect(quizBlock.pass).toBe(0.7);
    expect(quizBlock.questions).toHaveLength(2);
    // The STORED form keeps `correct` — only the HTTP response strips it
    // (routes/courses.ts). Proves the importer wrote the whole block, not a
    // pre-redacted one.
    expect(JSON.stringify(quizBlock)).toContain('"correct":true');
  });

  it('exits 1 naming the lesson whose track is not declared, and imports nothing', async () => {
    const { stderr, code } = await importCli(path.join(fixtures, 'unknown-track-course'));

    expect(code).toBe(1);
    expect(stderr).toContain('lesson-one.md');
    expect(stderr).toContain('no-such-track');

    const { rows } = await pool.query(`select count(*)::int as n from courses where slug = 'unknown-track-course'`);
    expect(rows[0].n).toBe(0);

    // The attempt is still on the record.
    const runs = await pool.query(
      `select status from import_runs where course_slug = 'unknown-track-course'`,
    );
    expect(runs.rows.map((r) => r.status)).toEqual(['failed']);
  });

  it('exits 1 with every validation problem when the manifest is broken', async () => {
    const { stderr, code } = await importCli(path.join(fixtures, 'multi-problem-course'));

    expect(code).toBe(1);
    expect(stderr).toContain('nothing was imported');
  });

  it('exits 1 for a directory that does not exist', async () => {
    const { stderr, code } = await importCli(path.join(fixtures, 'no-such-course'));

    expect(code).toBe(1);
    expect(stderr).toContain('not found');
  });
});
