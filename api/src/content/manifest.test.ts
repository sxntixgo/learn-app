import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadCourse, loadCourseManifest, resolveLessonPath } from './manifest.ts';

describe('manifest', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'manifest-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('loadCourseManifest', () => {
    it('parses and validates a valid course.yaml', async () => {
      await writeFile(
        path.join(dir, 'course.yaml'),
        [
          'schema: 1',
          'slug: fixture-course',
          'title: Fixture Course',
          'modules:',
          '  - id: intro',
          '    title: Introduction',
          '    lessons:',
          '      - modules/intro/one.md',
        ].join('\n'),
      );

      const manifest = await loadCourseManifest(dir);
      expect(manifest.slug).toBe('fixture-course');
      expect(manifest.modules).toHaveLength(1);
      expect(manifest.modules[0]!.lessons).toEqual(['modules/intro/one.md']);
    });

    it('falls back to course.yml when course.yaml is absent', async () => {
      await writeFile(
        path.join(dir, 'course.yml'),
        ['schema: 1', 'slug: yml-course', 'title: YML Course', 'modules:', '  - id: m', '    title: M', '    lessons: [a.md]'].join(
          '\n',
        ),
      );

      const manifest = await loadCourseManifest(dir);
      expect(manifest.slug).toBe('yml-course');
    });

    it('throws naming the directory when no manifest file exists', async () => {
      await expect(loadCourseManifest(dir)).rejects.toThrow(/course\.yaml|course\.yml/);
    });

    it('throws an error naming the file and JSON-Pointer path for a bad hue', async () => {
      await writeFile(
        path.join(dir, 'course.yaml'),
        [
          'schema: 1',
          'slug: fixture-course',
          'title: Fixture Course',
          'tracks:',
          '  - { id: cx, name: Complexity, hue: purple }',
          'modules:',
          '  - id: intro',
          '    title: Introduction',
          '    lessons: [modules/intro/one.md]',
        ].join('\n'),
      );

      await expect(loadCourseManifest(dir)).rejects.toThrow(/course\.yaml.*\/tracks\/0\/hue/s);
    });

    it('reports every problem, not just the first, across multiple lines', async () => {
      await writeFile(dir + '/course.yaml', ['schema: 2', 'title: Missing slug and modules'].join('\n'));

      try {
        await loadCourseManifest(dir);
        expect.unreachable('expected loadCourseManifest to throw');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const lines = message.split('\n');
        expect(lines.length).toBeGreaterThan(1);
        expect(message).toContain('/schema');
      }
    });
  });

  describe('resolveLessonPath', () => {
    it('resolves a manifest src path relative to the course directory', () => {
      const resolved = resolveLessonPath('/repos/course-a', 'modules/intro/one.md');
      expect(resolved).toBe(path.resolve('/repos/course-a', 'modules/intro/one.md'));
      expect(path.isAbsolute(resolved)).toBe(true);
    });
  });

  describe('loadCourse', () => {
    async function writeValidCourse(): Promise<void> {
      await mkdir(path.join(dir, 'modules', 'intro'), { recursive: true });
      await writeFile(
        path.join(dir, 'course.yaml'),
        [
          'schema: 1',
          'slug: fixture-course',
          'title: Fixture Course',
          'tracks:',
          '  - { id: cx, name: Complexity, hue: blue }',
          'modules:',
          '  - id: intro',
          '    title: Introduction',
          '    lessons:',
          '      - modules/intro/one.md',
          '      - modules/intro/two.md',
        ].join('\n'),
      );
      await writeFile(
        path.join(dir, 'modules', 'intro', 'one.md'),
        ['---', 'title: Lesson One', 'track: cx', 'kind: exercise', 'estimate: 10m', '---', '', 'Body one.', ''].join(
          '\n',
        ),
      );
      await writeFile(path.join(dir, 'modules', 'intro', 'two.md'), ['# Lesson Two', '', 'Body two.', ''].join('\n'));
    }

    it('loads course + tracks + modules + lessons with blocks and metadata, without touching the database', async () => {
      await writeValidCourse();

      const course = await loadCourse(dir);

      expect(course.slug).toBe('fixture-course');
      expect(course.tracks).toEqual([{ id: 'cx', name: 'Complexity', hue: 'blue' }]);
      expect(course.modules).toHaveLength(1);

      const [mod] = course.modules;
      expect(mod!.id).toBe('intro');
      expect(mod!.lessons).toHaveLength(2);

      const [one, two] = mod!.lessons;
      expect(one!.title).toBe('Lesson One');
      expect(one!.track).toBe('cx');
      expect(one!.kind).toBe('exercise');
      expect(one!.estimateMinutes).toBe(10);
      expect(one!.srcPath).toBe('modules/intro/one.md');
      expect(one!.blocks[0]).toMatchObject({ type: 'prose' });

      expect(two!.title).toBe('Lesson Two');
      expect(two!.kind).toBe('lesson');
    });

    it('throws an error naming the missing file when a manifest references a lesson that does not exist', async () => {
      await mkdir(path.join(dir, 'modules', 'intro'), { recursive: true });
      await writeFile(
        path.join(dir, 'course.yaml'),
        [
          'schema: 1',
          'slug: fixture-course',
          'title: Fixture Course',
          'modules:',
          '  - id: intro',
          '    title: Introduction',
          '    lessons:',
          '      - modules/intro/does-not-exist.md',
        ].join('\n'),
      );

      await expect(loadCourse(dir)).rejects.toThrow(/does-not-exist\.md/);
    });

    it('throws a clear error for a lesson with an invalid kind', async () => {
      await mkdir(path.join(dir, 'modules', 'intro'), { recursive: true });
      await writeFile(
        path.join(dir, 'course.yaml'),
        [
          'schema: 1',
          'slug: fixture-course',
          'title: Fixture Course',
          'modules:',
          '  - id: intro',
          '    title: Introduction',
          '    lessons:',
          '      - modules/intro/bad-kind.md',
        ].join('\n'),
      );
      await writeFile(
        path.join(dir, 'modules', 'intro', 'bad-kind.md'),
        ['---', 'title: Bad Kind', 'kind: essay', '---', '', 'Body.', ''].join('\n'),
      );

      await expect(loadCourse(dir)).rejects.toThrow(/bad-kind\.md.*kind/is);
    });
  });
});
