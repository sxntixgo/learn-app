import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCourse, loadCourseManifest, resolveLessonPath } from './manifest.ts';

const run = promisify(execFile);

// The committed hostile repo: `../../etc/passwd`, `/etc/passwd`, a symlinked
// lesson file and a symlinked intermediate directory, all named by a real
// course.yaml (design §8.1 — "manifest `src` paths are attacker-controlled").
const hostileFixture = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../tools/test-fixtures/hostile-course',
);

describe('resolveLessonPath — path traversal', () => {
  let base: string;
  let course: string;

  beforeAll(async () => {
    // `base/course` and `base/course-evil`: a sibling whose name has the
    // course directory's name as a prefix. A containment check written as
    // `resolved.startsWith(courseDir)` accepts everything in `course-evil`.
    base = await mkdtemp(path.join(tmpdir(), 'traversal-test-'));
    course = path.join(base, 'course');

    await mkdir(path.join(course, 'modules', 'intro'), { recursive: true });
    await mkdir(path.join(base, 'course-evil'), { recursive: true });
    await writeFile(path.join(course, 'modules', 'intro', 'one.md'), '# One\n');
    await writeFile(path.join(base, 'course-evil', 'stolen.md'), '# Stolen\n');
    await writeFile(path.join(base, 'outside.md'), '# Outside\n');

    // A symlinked lesson FILE, pointing out of the course directory.
    await symlink(path.join(base, 'outside.md'), path.join(course, 'linked-lesson.md'));
    // A symlinked INTERMEDIATE DIRECTORY. The final component is an ordinary
    // file; only checking the leaf misses this entirely.
    await symlink(path.join(base, 'course-evil'), path.join(course, 'linkdir'));
    // A symlink that stays INSIDE the course directory — still refused.
    await symlink(path.join(course, 'modules', 'intro', 'one.md'), path.join(course, 'inside-link.md'));
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('resolves a legitimate relative path to a file inside the course directory', () => {
    const resolved = resolveLessonPath(course, 'modules/intro/one.md');
    expect(resolved).toBe(path.join(course, 'modules', 'intro', 'one.md'));
  });

  it('rejects `../../etc/passwd` naming the offending entry and the reason', () => {
    expect(() => resolveLessonPath(course, '../../etc/passwd')).toThrow(
      /^\.\.\/\.\.\/etc\/passwd: contains a "\.\." segment/,
    );
  });

  it('rejects an absolute path', () => {
    expect(() => resolveLessonPath(course, '/etc/passwd')).toThrow(/^\/etc\/passwd: is an absolute path/);
  });

  it('rejects a Windows-style absolute path and a UNC path', () => {
    expect(() => resolveLessonPath(course, 'C:\\Windows\\win.ini')).toThrow(/is an absolute path/);
    expect(() => resolveLessonPath(course, '\\\\server\\share\\x.md')).toThrow(/is an absolute path/);
  });

  it('rejects traversal that starts inside a real subdirectory', () => {
    expect(() => resolveLessonPath(course, 'modules/intro/../../../outside.md')).toThrow(/contains a "\.\." segment/);
  });

  it('rejects traversal written with backslashes', () => {
    expect(() => resolveLessonPath(course, 'modules\\..\\..\\outside.md')).toThrow(/contains a "\.\." segment/);
  });

  it('rejects a path into a sibling directory that shares the course directory name as a prefix', () => {
    // `/…/course-evil` is not inside `/…/course`, however similar the strings
    // look. This is the case a `startsWith` containment check gets wrong.
    expect(() => resolveLessonPath(course, '../course-evil/stolen.md')).toThrow();
    // …and the prefix-sharing sibling does not disturb a legitimate path.
    expect(resolveLessonPath(course, 'modules/intro/one.md')).toContain(`${path.sep}course${path.sep}`);
  });

  it('rejects a symlinked lesson FILE, naming the link', () => {
    expect(() => resolveLessonPath(course, 'linked-lesson.md')).toThrow(
      /^linked-lesson\.md: "linked-lesson\.md" is a symbolic link/,
    );
  });

  it('rejects a symlinked INTERMEDIATE DIRECTORY, naming the directory rather than the leaf', () => {
    expect(() => resolveLessonPath(course, 'linkdir/stolen.md')).toThrow(
      /^linkdir\/stolen\.md: "linkdir" is a symbolic link/,
    );
  });

  it('rejects a symlink even when its target is inside the course directory', () => {
    expect(() => resolveLessonPath(course, 'inside-link.md')).toThrow(/is a symbolic link/);
  });

  it('rejects a NUL byte, an empty path and a whitespace-only path', () => {
    expect(() => resolveLessonPath(course, 'one\0.md')).toThrow(/contains a NUL byte/);
    expect(() => resolveLessonPath(course, '')).toThrow(/non-empty strings/);
    expect(() => resolveLessonPath(course, '   ')).toThrow(/non-empty strings/);
  });

  it('rejects a path that resolves to something other than a regular file', async () => {
    const fifo = path.join(course, 'pipe.md');
    try {
      await run('mkfifo', [fifo]);
    } catch {
      return; // no mkfifo on this platform; the check is still exercised by review
    }
    // Without this, `readFile` on a FIFO blocks the importer forever.
    expect(() => resolveLessonPath(course, 'pipe.md')).toThrow(/is not a regular file/);
    await rm(fifo, { force: true });
  });

  it('still resolves when the course directory itself is reached through a symlink', async () => {
    const alias = path.join(base, 'alias');
    await symlink(course, alias);
    expect(resolveLessonPath(alias, 'modules/intro/one.md')).toBe(
      path.join(course, 'modules', 'intro', 'one.md'),
    );
  });
});

describe('loadCourse — the hostile fixture repo', () => {
  it('refuses the whole course on the first traversal entry, naming it', async () => {
    // loadCourse throws on the first problem by design (one transaction per
    // import). tools/src/hostile-fixture.test.ts asserts every rejection.
    await expect(loadCourse(hostileFixture)).rejects.toThrow(
      /^\.\.\/\.\.\/etc\/passwd: contains a "\.\." segment/,
    );
  });
});

describe('loadCourseManifest — the manifest file itself', () => {
  it('refuses a course.yaml that is a symlink', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'manifest-symlink-'));
    try {
      await writeFile(path.join(dir, 'real.yaml'), 'schema: 1\n');
      await symlink(path.join(dir, 'real.yaml'), path.join(dir, 'course.yaml'));

      await expect(loadCourseManifest(dir)).rejects.toThrow(/course\.yaml is a symbolic link/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
