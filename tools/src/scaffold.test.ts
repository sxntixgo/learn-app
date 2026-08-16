import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { describe, it, expect } from 'vitest';
import { validateCourseManifest } from '@learn/api/content/validate';
import { scaffoldCourse } from './scaffold.ts';
import { validateCourseDir } from './validate.ts';

const run = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
const scaffoldCli = path.join(here, 'scaffold.ts');
const fixturesDir = path.resolve(here, '../test-fixtures');

interface ExecFileError {
  code?: number;
  stdout?: string;
  stderr?: string;
}

async function runScaffold(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return run(process.execPath, [scaffoldCli, ...args]);
}

describe('scaffoldCourse', () => {
  it('orders numeric-prefixed directories and files numerically, not lexically (9 before 10)', async () => {
    const result = await scaffoldCourse(path.join(fixturesDir, 'scaffold-numeric-order'));

    expect(result.modules.map((m) => m.id)).toEqual(['intro', 'second', 'ninth', 'tenth']);

    const introLessons = result.modules[0]!.lessons.map((l) => l.relPath);
    expect(introLessons).toEqual([
      '01-intro/1-a.md',
      '01-intro/2-b.md',
      '01-intro/9-i.md',
      '01-intro/10-j.md',
    ]);
  });

  it('falls back to alphabetical ordering when there are no numeric prefixes', async () => {
    const result = await scaffoldCourse(path.join(fixturesDir, 'scaffold-no-prefix'));

    expect(result.modules.map((m) => m.id)).toEqual(['alpha', 'beta']);
    expect(result.modules[0]!.lessons.map((l) => l.relPath)).toEqual([
      'alpha/alpha.md',
      'alpha/zeta.md',
    ]);
  });

  it('does not fail when a lesson has no frontmatter title and no level-1 heading', async () => {
    const result = await scaffoldCourse(path.join(fixturesDir, 'scaffold-no-title'));

    const mod = result.modules[0]!;
    const noTitleLesson = mod.lessons.find((l) => l.relPath.endsWith('no-title.md'));
    const titledLesson = mod.lessons.find((l) => l.relPath.endsWith('has-title.md'));

    expect(noTitleLesson).toBeDefined();
    expect(noTitleLesson!.titleSource).toBe('filename');
    expect(noTitleLesson!.title).toBe('No Title');

    expect(titledLesson).toBeDefined();
    expect(titledLesson!.titleSource).toBe('parsed');
    expect(titledLesson!.title).toBe('Has Title');
  });

  it('skips README/CHANGELOG at the repo root but keeps a README inside a module directory', async () => {
    const result = await scaffoldCourse(path.join(fixturesDir, 'scaffold-readme'));

    expect(result.modules).toHaveLength(1);
    const lessonPaths = result.modules[0]!.lessons.map((l) => l.relPath);
    expect(lessonPaths).toContain('mod-one/README.md');
    expect(lessonPaths).toContain('mod-one/lesson.md');

    const skippedPaths = result.skipped.map((s) => s.path);
    expect(skippedPaths).toContain('README.md');
    expect(skippedPaths).toContain('CHANGELOG.md');
  });

  it('skips .git, node_modules, and docs/-style build-output directories', async () => {
    // `.git/` and `node_modules/` cannot be committed as fixtures — git refuses to
    // track a nested .git, and node_modules is gitignored. Relying on them being on
    // disk passes locally and fails only in CI, which is exactly what happened. Build
    // them at runtime so the test is hermetic.
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'scaffold-skip-'));
    try {
      await cp(path.join(fixturesDir, 'scaffold-skip-dirs'), tmp, { recursive: true });
      for (const dir of ['.git', 'node_modules']) {
        await mkdir(path.join(tmp, dir), { recursive: true });
        await writeFile(path.join(tmp, dir, 'ignore-me.md'), '# Should never be a lesson\n');
      }

      const result = await scaffoldCourse(tmp);

      expect(result.modules).toHaveLength(1);
      expect(result.modules[0]!.id).toBe('mod-one');

      const skippedPaths = result.skipped.map((s) => s.path);
      expect(skippedPaths).toContain('.git/');
      expect(skippedPaths).toContain('node_modules/');
      expect(skippedPaths).toContain('docs/');

      // and nothing inside them leaked in as a lesson
      const allLessons = result.modules.flatMap((m) => m.lessons.map((l) => l.relPath));
      expect(allLessons.some((p) => p.includes('ignore-me'))).toBe(false);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('does not emit a tracks key, and comments the five allowed hues instead', async () => {
    const result = await scaffoldCourse(path.join(fixturesDir, 'scaffold-numeric-order'));

    expect(result.manifest.tracks).toBeUndefined();
    expect(result.yaml).not.toMatch(/^tracks:/m);
    expect(result.yaml).toContain('blue, teal, ochre, maroon, slate');
  });

  it('produces a manifest that validates against schemas/course.schema.json', async () => {
    const result = await scaffoldCourse(path.join(fixturesDir, 'scaffold-numeric-order'));

    // Critical end-to-end check: the generated YAML, parsed back, must
    // satisfy the same validator the platform uses — a scaffolder that
    // emits an invalid manifest is worse than none.
    const parsed: unknown = parseYaml(result.yaml);
    const validation = validateCourseManifest(parsed);
    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  it('produces a manifest that passes the full validate-only pipeline (validateCourseDir) end to end', async () => {
    const fixtureDir = path.join(fixturesDir, 'scaffold-readme');
    const result = await scaffoldCourse(fixtureDir);

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'scaffold-e2e-'));
    try {
      await cp(fixtureDir, tmpDir, { recursive: true });
      await writeFile(path.join(tmpDir, 'course.yaml'), result.yaml, 'utf8');

      const validation = await validateCourseDir(tmpDir);
      expect(validation.problems).toEqual([]);
      expect(validation.ok).toBe(true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('scaffold CLI', () => {
  it('prints YAML to stdout and a human summary to stderr', async () => {
    const { stdout, stderr } = await runScaffold([path.join(fixturesDir, 'scaffold-numeric-order')]);

    expect(stdout).toContain('schema: 1');
    expect(stdout).toContain('modules:');
    expect(stderr).toMatch(/4 module\(s\), 7 lesson\(s\)/);
  });

  it('lists skipped files with a reason in the stderr summary', async () => {
    const { stderr } = await runScaffold([path.join(fixturesDir, 'scaffold-readme')]);

    expect(stderr).toContain('README.md');
    expect(stderr).toMatch(/README\.md.*—.*root/);
  });

  it('writes to --out and refuses to overwrite an existing file without --force', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'scaffold-cli-'));
    const outFile = path.join(tmpDir, 'course.yaml');
    try {
      await runScaffold([path.join(fixturesDir, 'scaffold-numeric-order'), '--out', outFile]);
      expect(existsSync(outFile)).toBe(true);
      const firstContent = await readFile(outFile, 'utf8');
      expect(firstContent).toContain('schema: 1');

      await expect(
        runScaffold([path.join(fixturesDir, 'scaffold-numeric-order'), '--out', outFile]),
      ).rejects.toThrow();

      try {
        await runScaffold([path.join(fixturesDir, 'scaffold-numeric-order'), '--out', outFile]);
        expect.unreachable('expected non-zero exit without --force');
      } catch (err) {
        const { code, stderr } = err as ExecFileError;
        expect(code).toBe(1);
        expect(stderr).toMatch(/refus/i);
        expect(stderr).toContain('--force');
      }

      await runScaffold([path.join(fixturesDir, 'scaffold-numeric-order'), '--out', outFile, '--force']);
      const secondContent = await readFile(outFile, 'utf8');
      expect(secondContent).toContain('schema: 1');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
