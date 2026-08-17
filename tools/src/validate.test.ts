import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, it, expect } from 'vitest';

const run = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
const validateCli = path.join(here, 'validate.ts');
const fixturesDir = path.resolve(here, '../test-fixtures');

interface ExecFileError {
  code?: number;
  stdout?: string;
  stderr?: string;
}

/**
 * Runs the actual validate CLI as a subprocess, the way `seed.test.ts`
 * exercises `seed.ts` — this proves the real binary works end to end,
 * not a reimplementation of its logic.
 */
async function runValidate(dir: string): Promise<{ stdout: string; stderr: string }> {
  return run(process.execPath, [validateCli, dir]);
}

describe('validate CLI', () => {
  it('exits 0 with a summary (course slug, module count, lesson count) for a valid fixture', async () => {
    const { stdout } = await runValidate(path.join(fixturesDir, 'valid-course'));
    expect(stdout).toContain('fixture-course');
    expect(stdout).toMatch(/1 module/);
    expect(stdout).toMatch(/2 lesson/);
  });

  it('exits 1 naming the JSON-Pointer path for a bad hue', async () => {
    await expect(runValidate(path.join(fixturesDir, 'bad-hue-course'))).rejects.toThrow();

    try {
      await runValidate(path.join(fixturesDir, 'bad-hue-course'));
      expect.unreachable('expected non-zero exit');
    } catch (err) {
      const { code, stderr } = err as ExecFileError;
      expect(code).toBe(1);
      expect(stderr).toContain('/tracks/0/hue');
    }
  });

  it('exits 1 naming the missing lesson file', async () => {
    try {
      await runValidate(path.join(fixturesDir, 'missing-lesson-course'));
      expect.unreachable('expected non-zero exit');
    } catch (err) {
      const { code, stderr } = err as ExecFileError;
      expect(code).toBe(1);
      expect(stderr).toContain('modules/01-intro/does-not-exist.md');
    }
  });

  it('exits 1 naming the file with an invalid lesson kind', async () => {
    try {
      await runValidate(path.join(fixturesDir, 'bad-kind-course'));
      expect.unreachable('expected non-zero exit');
    } catch (err) {
      const { code, stderr } = err as ExecFileError;
      expect(code).toBe(1);
      expect(stderr).toContain('modules/01-intro/bad-kind.md');
      expect(stderr).toMatch(/kind/i);
    }
  });

  it('exits 0 for a fixture course with a quiz block (design §6.3, Task A)', async () => {
    const { stdout } = await runValidate(path.join(fixturesDir, 'quiz-course'));
    expect(stdout).toContain('quiz-fixture-course');
    expect(stdout).toMatch(/1 module/);
    expect(stdout).toMatch(/1 lesson/);
  });

  it('exits 1 naming the choices array when a quiz question has no correct answer (Task A)', async () => {
    try {
      await runValidate(path.join(fixturesDir, 'quiz-no-correct-course'));
      expect.unreachable('expected non-zero exit');
    } catch (err) {
      const { code, stderr } = err as ExecFileError;
      expect(code).toBe(1);
      expect(stderr).toContain('modules/01-intro/quiz-one.md');
      expect(stderr).toContain('/1/questions/1/choices');
      expect(stderr).toMatch(/contain/i);
    }
  });

  it('prints EVERY problem, not just the first, when a course has more than one broken lesson', async () => {
    try {
      await runValidate(path.join(fixturesDir, 'multi-problem-course'));
      expect.unreachable('expected non-zero exit');
    } catch (err) {
      const { code, stderr } = err as ExecFileError;
      expect(code).toBe(1);
      // One broken lesson is a missing file, the other an invalid `kind` —
      // both must be present, proving the CLI doesn't stop at the first.
      expect(stderr).toContain('modules/01-intro/does-not-exist.md');
      expect(stderr).toContain('modules/01-intro/bad-kind.md');
      expect(stderr!.trim().split('\n').length).toBeGreaterThanOrEqual(2);
    }
  });
});
