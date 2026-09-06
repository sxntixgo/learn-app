import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateCourseDir } from './validate-dir.ts';

// ---------------------------------------------------------------------------
// The validate-only pipeline (design §8: "Validate-only mode is a first-class
// entry point, not a debug flag"), exercised directly against a directory on
// disk rather than through the import pipeline that usually calls it.
//
// The behaviour under test is NOT "does it notice a broken lesson" — every
// individual check it delegates to (loadCourseManifest, resolveLessonPath,
// parseLesson, resolveChartSidecars, validateBlocks) has its own tests. It is
// the thing this module adds on top of them and nothing else does: it
// COLLECTS every problem instead of stopping at the first, and it keeps going
// to the next lesson after each kind of failure. An author fixing a content
// repo runs this once and gets the whole list; a version that aborted on the
// first problem would make that "run, fix one line, run again" for as many
// rounds as the repo has mistakes, which is the failure mode design §8 calls
// out by name.
//
// The other thing it owns is `slug`: the admin import route records a
// `course_slug` on a FAILED import_runs row, and it can only do that when the
// manifest itself parsed. So every failing case below asserts whether the slug
// survived, because that is the difference between an import history an
// operator can read and a list of anonymous failures.
// ---------------------------------------------------------------------------

const VALID_LESSON = '---\ntitle: One\n---\n\nHello.\n';

describe('validateCourseDir', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'validate-dir-test-'));
    await mkdir(path.join(dir, 'modules'), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Writes a course.yaml whose single module lists exactly `lessons`. */
  async function writeManifest(lessons: string[], slug = 'valid-course'): Promise<void> {
    await writeFile(
      path.join(dir, 'course.yaml'),
      [
        'schema: 1',
        `slug: ${slug}`,
        'title: Validate Dir Fixture',
        'modules:',
        '  - id: intro',
        '    title: Introduction',
        '    lessons:',
        ...lessons.map((l) => `      - ${l}`),
      ].join('\n'),
    );
  }

  it('reports ok with a summary counting the modules and lessons it actually walked', async () => {
    await writeFile(
      path.join(dir, 'course.yaml'),
      [
        'schema: 1',
        'slug: two-module-course',
        'title: Validate Dir Fixture',
        'modules:',
        '  - id: intro',
        '    title: Introduction',
        '    lessons:',
        '      - modules/one.md',
        '      - modules/two.md',
        '  - id: deeper',
        '    title: Deeper',
        '    lessons:',
        '      - modules/three.md',
      ].join('\n'),
    );
    for (const name of ['one.md', 'two.md', 'three.md']) {
      await writeFile(path.join(dir, 'modules', name), VALID_LESSON);
    }

    const result = await validateCourseDir(dir);

    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.slug).toBe('two-module-course');
    expect(result.summary).toEqual({ slug: 'two-module-course', moduleCount: 2, lessonCount: 3 });
  });

  it('reports the missing manifest and no slug when the directory holds no course.yaml at all', async () => {
    const result = await validateCourseDir(dir);

    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain(dir);
    expect(result.problems[0]).toContain('course.yaml');
    // Nothing parsed, so there is no slug to record the failed run under.
    expect(result.slug).toBeUndefined();
    expect(result.summary).toBeUndefined();
  });

  it('splits a multi-problem manifest error into one problem per line, still with no slug', async () => {
    // loadCourseManifest throws ONE Error whose message has a line per schema
    // problem. Returning that as a single problem string would put four
    // failures in one bullet on the admin screen; splitting is what makes the
    // list a list.
    await writeFile(
      path.join(dir, 'course.yaml'),
      [
        'schema: 1',
        'slug: bad-manifest',
        'title: Bad',
        'tracks:',
        '  - id: t1',
        '    name: T1',
        '    hue: chartreuse',
        'modules:',
        '  - id: intro',
        '    title: Introduction',
        '    lessons: []',
      ].join('\n'),
    );

    const result = await validateCourseDir(dir);

    expect(result.ok).toBe(false);
    expect(result.problems.length).toBeGreaterThan(1);
    expect(result.problems.some((p) => p.includes('/tracks/0/hue'))).toBe(true);
    expect(result.problems.some((p) => p.includes('/modules/0/lessons'))).toBe(true);
    for (const problem of result.problems) {
      expect(problem).toMatch(/^course\.yaml:/);
      expect(problem).not.toContain('\n');
    }
    // The manifest never validated, so nothing may claim to know its slug —
    // even though the file plainly contains one.
    expect(result.slug).toBeUndefined();
  });

  it('collects a refused traversal path AND keeps validating the lessons after it', async () => {
    // A hostile manifest usually has more than one bad entry, and an author
    // fixing a merely-careless one wants all of them at once. If this aborted
    // at the first refusal, the second entry below would never be reported.
    await writeManifest(['../../../../etc/passwd', 'modules/gone.md', 'modules/one.md']);
    await writeFile(path.join(dir, 'modules/one.md'), VALID_LESSON);

    const result = await validateCourseDir(dir);

    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(2);

    const traversal = result.problems[0]!;
    expect(traversal).toContain('../../../../etc/passwd');
    expect(traversal).toMatch(/climb out of the course directory/);
    // Naming the module is what tells the author WHICH list to go and edit.
    expect(traversal).toContain('referenced by module "intro"');
    // A rejection must never echo the resolved absolute path — that would
    // turn the error message into a filesystem-layout oracle.
    expect(traversal).not.toContain(dir);

    expect(result.problems[1]).toContain('modules/gone.md: lesson file not found');
    expect(result.problems[1]).toContain('referenced by module "intro"');

    // The manifest itself was fine, so a failed import_runs row can still name
    // the course this attempt was for.
    expect(result.slug).toBe('valid-course');
  });

  it('collects a read failure rather than letting it escape as an exception', async () => {
    // A lesson entry pointing at a DIRECTORY passes both the containment check
    // and existsSync, and only fails when readFile is attempted (EISDIR). This
    // is the one lesson-level failure that is neither a refusal nor a missing
    // file, and an uncaught EISDIR here would abort the whole validate run.
    await mkdir(path.join(dir, 'modules/not-a-file.md'));
    await writeManifest(['modules/not-a-file.md', 'modules/one.md']);
    await writeFile(path.join(dir, 'modules/one.md'), VALID_LESSON);

    const result = await validateCourseDir(dir);

    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatch(/^modules\/not-a-file\.md: could not read file — /);
    expect(result.slug).toBe('valid-course');
  });

  it('reports a lesson that cannot be parsed, prefixed with the file the author has to open', async () => {
    await writeManifest(['modules/untitled.md']);
    await writeFile(path.join(dir, 'modules/untitled.md'), 'Just a paragraph, no title anywhere.\n');

    const result = await validateCourseDir(dir);

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      'modules/untitled.md: Could not determine lesson title: no YAML frontmatter "title" field and no level-1 heading found.',
    ]);
  });

  it('reports a missing chart CSV sidecar — validate-only resolves sidecars exactly as a real import does', async () => {
    // design §6.3 Task C: "a missing sidecar fails validation naming the file".
    // If validate-only skipped sidecar resolution, a repo would pass validation
    // and then fail at import, which is the split this pipeline exists to avoid.
    await writeManifest(['modules/chart.md']);
    await writeFile(
      path.join(dir, 'modules/chart.md'),
      '---\ntitle: Chart\n---\n\n```chart\nkind: bar\ncaption: Growth\ndata: ./missing.csv\n```\n',
    );

    const result = await validateCourseDir(dir);

    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain('modules/chart.md:');
    expect(result.problems[0]).toContain('./missing.csv');
    expect(result.problems[0]).toMatch(/sidecar not found/);
  });

  it('reports every block-schema error of a lesson with its JSON Pointer, and continues to the next lesson', async () => {
    await writeManifest(['modules/quiz.md', 'modules/untitled.md']);
    await writeFile(
      path.join(dir, 'modules/quiz.md'),
      '---\ntitle: Quiz\n---\n\n```quiz\npass: 4\nquestions: []\n```\n',
    );
    await writeFile(path.join(dir, 'modules/untitled.md'), 'No title here.\n');

    const result = await validateCourseDir(dir);

    expect(result.ok).toBe(false);
    // Block errors do NOT `continue` — every error of the offending lesson is
    // reported, and the run still reaches the lesson after it.
    expect(result.problems.length).toBeGreaterThan(1);
    expect(result.problems.some((p) => p.startsWith('modules/quiz.md:/0/pass'))).toBe(true);
    expect(result.problems.some((p) => p.startsWith('modules/quiz.md:/0/questions'))).toBe(true);
    expect(result.problems.some((p) => p.startsWith('modules/untitled.md: Could not determine'))).toBe(true);
    expect(result.slug).toBe('valid-course');
    // A failed run never reports a summary — there is nothing to summarise.
    expect(result.summary).toBeUndefined();
  });
});
