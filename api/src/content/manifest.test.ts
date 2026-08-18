import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Block } from './parse.ts';
import { loadCourse, loadCourseManifest, resolveChartSidecars, resolveLessonPath } from './manifest.ts';

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

    it('resolves a chart CSV sidecar into inline rows (design §6.3, Task C)', async () => {
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
          '      - modules/intro/chart.md',
        ].join('\n'),
      );
      await writeFile(
        path.join(dir, 'modules', 'intro', 'chart.md'),
        [
          '---',
          'title: Chart Lesson',
          '---',
          '',
          '```chart',
          'kind: bar',
          'caption: Enrollment over time',
          'data: ./enrollment.csv',
          '```',
          '',
        ].join('\n'),
      );
      await writeFile(
        path.join(dir, 'modules', 'intro', 'enrollment.csv'),
        ['label,value', 'Week 1,5', 'Week 2,9'].join('\n'),
      );

      const course = await loadCourse(dir);
      const [chart] = course.modules[0]!.lessons[0]!.blocks as Block[];
      expect(chart).toEqual({
        type: 'chart',
        kind: 'bar',
        caption: 'Enrollment over time',
        data: [
          { label: 'Week 1', value: 5 },
          { label: 'Week 2', value: 9 },
        ],
      });
    });

    it('throws naming a missing chart CSV sidecar', async () => {
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
          '      - modules/intro/chart.md',
        ].join('\n'),
      );
      await writeFile(
        path.join(dir, 'modules', 'intro', 'chart.md'),
        ['---', 'title: Chart Lesson', '---', '', '```chart', 'kind: bar', 'caption: X', 'data: ./missing.csv', '```', ''].join(
          '\n',
        ),
      );

      await expect(loadCourse(dir)).rejects.toThrow(/missing\.csv.*not found/is);
    });
  });

  describe('resolveChartSidecars (design §6.3, Task C)', () => {
    beforeEach(async () => {
      await mkdir(path.join(dir, 'modules', 'intro'), { recursive: true });
    });

    function chartBlock(data: string): Block {
      return { type: 'chart', kind: 'bar', caption: 'x', data };
    }

    it('passes non-chart blocks through unchanged', async () => {
      const blocks: Block[] = [{ type: 'prose', html: '<p>hi</p>' }];
      const resolved = await resolveChartSidecars(dir, 'modules/intro/lesson.md', blocks);
      expect(resolved).toEqual(blocks);
    });

    it('passes a chart block with inline (already-array) data through unchanged', async () => {
      const blocks: Block[] = [{ type: 'chart', kind: 'bar', caption: 'x', data: [{ label: 'a', value: 1 }] }];
      const resolved = await resolveChartSidecars(dir, 'modules/intro/lesson.md', blocks);
      expect(resolved).toEqual(blocks);
    });

    it('resolves a sidecar relative to the LESSON directory, not the course root', async () => {
      await writeFile(path.join(dir, 'modules', 'intro', 'data.csv'), ['label,value', 'a,1'].join('\n'));
      const resolved = await resolveChartSidecars(dir, 'modules/intro/lesson.md', [chartBlock('./data.csv')]);
      expect(resolved).toEqual([{ type: 'chart', kind: 'bar', caption: 'x', data: [{ label: 'a', value: 1 }] }]);
    });

    it('throws naming the sidecar path when the file does not exist', async () => {
      await expect(
        resolveChartSidecars(dir, 'modules/intro/lesson.md', [chartBlock('./missing.csv')]),
      ).rejects.toThrow(/missing\.csv.*not found/is);
    });

    it('throws (via resolveLessonPath) when the sidecar path climbs out of the course directory', async () => {
      // dirname("modules/intro/lesson.md") is "modules/intro"; four levels
      // of ".." from there escapes past `dir` itself — the SAME traversal
      // defense resolveLessonPath already applies to lesson paths.
      await expect(
        resolveChartSidecars(dir, 'modules/intro/lesson.md', [chartBlock('../../../../etc/passwd')]),
      ).rejects.toThrow(/chart data sidecar/i);
    });

    it('refuses a sidecar reached through a symlinked file', async () => {
      const outside = await mkdtemp(path.join(tmpdir(), 'chart-sidecar-outside-'));
      try {
        await writeFile(path.join(outside, 'secret.csv'), ['label,value', 'a,1'].join('\n'));
        await symlink(path.join(outside, 'secret.csv'), path.join(dir, 'modules', 'intro', 'linked.csv'));

        await expect(
          resolveChartSidecars(dir, 'modules/intro/lesson.md', [chartBlock('./linked.csv')]),
        ).rejects.toThrow(/symbolic link/i);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    it('throws naming the sidecar path when the CSV is malformed', async () => {
      await writeFile(path.join(dir, 'modules', 'intro', 'bad.csv'), ['label,value', 'a,not-a-number'].join('\n'));
      await expect(resolveChartSidecars(dir, 'modules/intro/lesson.md', [chartBlock('./bad.csv')])).rejects.toThrow(
        /bad\.csv.*not a number/is,
      );
    });
  });
});
