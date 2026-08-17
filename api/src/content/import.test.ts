import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { importCourse } from './import.ts';
import { loadCourse } from './manifest.ts';

const run = promisify(execFile);
const { Pool } = pg;

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is not set — required to run import.test.ts');
}

const here = path.dirname(fileURLToPath(import.meta.url));
const migrateCli = path.resolve(here, '../../../tools/src/migrate.ts');

// Every course this file creates uses a slug under this prefix so afterAll can
// clean up without guessing.
const SLUG_PREFIX = 'import-test';

const pool = new Pool({ connectionString });

// ---------------------------------------------------------------------------
// Fixture writing
//
// These tests need to EDIT a course between imports (change one lesson, drop a
// lesson, put it back), which a static fixture directory cannot express — so
// each test writes the exact manifest it needs into its own temp directory.
// tools/test-fixtures/valid-course stays the static fixture the CLI test uses.
// ---------------------------------------------------------------------------

interface LessonSpec {
  /** Course-relative path, e.g. "modules/01-intro/lesson-one.md". */
  file: string;
  body: string;
}

interface ModuleSpec {
  id: string;
  title: string;
  lessons: LessonSpec[];
}

interface CourseSpec {
  slug: string;
  title?: string;
  tracks?: { id: string; name: string; hue: string }[];
  modules: ModuleSpec[];
}

async function writeCourse(dir: string, spec: CourseSpec): Promise<string> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  const manifest = {
    schema: 1,
    slug: spec.slug,
    title: spec.title ?? 'Import Test Course',
    ...(spec.tracks ? { tracks: spec.tracks } : {}),
    modules: spec.modules.map((m) => ({
      id: m.id,
      title: m.title,
      lessons: m.lessons.map((l) => l.file),
    })),
  };
  await writeFile(path.join(dir, 'course.yaml'), JSON.stringify(manifest, null, 2));

  for (const mod of spec.modules) {
    for (const lesson of mod.lessons) {
      const abs = path.join(dir, lesson.file);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, lesson.body);
    }
  }
  return dir;
}

function lesson(file: string, title: string, body = 'Some prose.'): LessonSpec {
  return { file, body: `---\ntitle: ${title}\n---\n\n${body}\n` };
}

/** Loads and imports a course directory on its own connection, as a caller would. */
async function importDir(
  dir: string,
  opts: { commit?: string | null } = {},
): Promise<Awaited<ReturnType<typeof importCourse>>> {
  const course = await loadCourse(dir);
  const client = await pool.connect();
  try {
    return await importCourse(client, course, opts);
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Reading the database back
// ---------------------------------------------------------------------------

interface LessonRow {
  id: string;
  module_key: string;
  lesson_key: string;
  slug: string;
  title: string;
  kind: string;
  position: number;
  track_key: string | null;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
  content_hash: string;
  blocks: unknown;
  source_path: string;
  estimate_minutes: number | null;
}

async function lessonRows(slug: string): Promise<LessonRow[]> {
  const { rows } = await pool.query<LessonRow>(
    `select l.id, m.key as module_key, l.lesson_key, l.slug, l.title, l.kind, l.position,
            t.key as track_key, l.archived_at, l.created_at, l.updated_at,
            l.content_hash, l.blocks, l.source_path, l.estimate_minutes
       from lessons l
       join modules m on m.id = l.module_id
       join courses c on c.id = l.course_id
       left join tracks t on t.id = l.track_id
      where c.slug = $1
      order by m.position, l.position`,
    [slug],
  );
  return rows;
}

/**
 * Everything the import is allowed to touch for one course, in one comparable
 * value. Used by the rollback test: if a failed import left ANY trace, the
 * before/after snapshots differ.
 */
async function snapshot(slug: string): Promise<unknown> {
  const course = await pool.query(
    `select id, slug, title, subtitle, description, tags, imported_commit, repo_id, created_at, updated_at
       from courses where slug = $1`,
    [slug],
  );
  const courseId: string | undefined = course.rows[0]?.id;
  const tracks = await pool.query(
    `select id, key, name, hue, blurb, position from tracks where course_id = $1 order by position, key`,
    [courseId ?? null],
  );
  const modules = await pool.query(
    `select id, key, title, position, archived_at from modules where course_id = $1 order by position, key`,
    [courseId ?? null],
  );
  return { course: course.rows, tracks: tracks.rows, modules: modules.rows, lessons: await lessonRows(slug) };
}

async function importRuns(slug: string) {
  const { rows } = await pool.query(
    `select id, course_slug, status, started_at, finished_at, commit_sha, log
       from import_runs where course_slug = $1 order by started_at, id`,
    [slug],
  );
  return rows;
}

describe.sequential('importCourse', () => {
  let tmp: string;

  beforeAll(async () => {
    // Real schema, applied by the real migration runner.
    await run(process.execPath, [migrateCli], { env: { ...process.env, DATABASE_URL: connectionString } });
    tmp = await mkdtemp(path.join(tmpdir(), 'import-test-'));
  });

  afterAll(async () => {
    await pool.query(`delete from import_runs where course_slug like $1`, [`${SLUG_PREFIX}-%`]);
    await pool.query(`delete from courses where slug like $1`, [`${SLUG_PREFIX}-%`]);
    await pool.end();
    await rm(tmp, { recursive: true, force: true });
  });

  it('creates the course, tracks, modules and lessons with manifest order as position', async () => {
    const slug = `${SLUG_PREFIX}-fresh`;
    const dir = await writeCourse(path.join(tmp, 'fresh'), {
      slug,
      title: 'Fresh Course',
      tracks: [
        { id: 'cx', name: 'Complexity', hue: 'blue' },
        { id: 'cr', name: 'Craft', hue: 'maroon' },
      ],
      modules: [
        {
          id: 'intro',
          title: 'Introduction',
          lessons: [
            { file: 'modules/01-intro/one.md', body: '---\ntitle: One\ntrack: cx\nkind: exercise\nestimate: 10m\n---\n\nFirst.\n' },
            lesson('modules/01-intro/two.md', 'Two'),
          ],
        },
        {
          id: 'deeper',
          title: 'Going deeper',
          lessons: [lesson('modules/02-deeper/three.md', 'Three')],
        },
      ],
    });

    const result = await importDir(dir);

    expect(result.counts.lessons).toEqual({ created: 3, updated: 0, skipped: 0, archived: 0 });
    expect(result.counts.modules.created).toBe(2);
    expect(result.counts.tracks.created).toBe(2);
    expect(result.counts.courses.created).toBe(1);

    const course = await pool.query(`select id, title from courses where slug = $1`, [slug]);
    expect(course.rowCount).toBe(1);
    expect(course.rows[0].title).toBe('Fresh Course');

    const modules = await pool.query(
      `select key, title, position from modules where course_id = $1 order by position`,
      [course.rows[0].id],
    );
    expect(modules.rows.map((r) => [r.key, r.position])).toEqual([
      ['intro', 0],
      ['deeper', 1],
    ]);

    const lessons = await lessonRows(slug);
    expect(lessons.map((l) => [l.module_key, l.lesson_key, l.position])).toEqual([
      ['intro', 'modules/01-intro/one', 0],
      ['intro', 'modules/01-intro/two', 1],
      ['deeper', 'modules/02-deeper/three', 0],
    ]);
    expect(lessons.map((l) => l.title)).toEqual(['One', 'Two', 'Three']);
    // Track comes from lesson frontmatter, resolved to the course's track row.
    expect(lessons[0]!.track_key).toBe('cx');
    expect(lessons[1]!.track_key).toBeNull();
    expect(lessons[0]!.kind).toBe('exercise');
    expect(lessons[0]!.estimate_minutes).toBe(10);
    // Slugs are unique per course and stable, even for identical filenames in
    // different modules.
    expect(new Set(lessons.map((l) => l.slug)).size).toBe(3);

    const runs = await importRuns(slug);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('success');
    expect(runs[0].finished_at).not.toBeNull();
    expect(runs[0].log.counts.lessons.created).toBe(3);
  });

  it('records imported_commit when given one, and null for a local directory import', async () => {
    const slug = `${SLUG_PREFIX}-commit`;
    const dir = await writeCourse(path.join(tmp, 'commit'), {
      slug,
      modules: [{ id: 'm', title: 'M', lessons: [lesson('m/a.md', 'A')] }],
    });

    await importDir(dir, { commit: 'a'.repeat(40) });
    let row = await pool.query(`select imported_commit from courses where slug = $1`, [slug]);
    expect(row.rows[0].imported_commit).toBe('a'.repeat(40));
    expect((await importRuns(slug))[0].commit_sha).toBe('a'.repeat(40));

    await importDir(dir);
    row = await pool.query(`select imported_commit from courses where slug = $1`, [slug]);
    expect(row.rows[0].imported_commit).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Design §12 / migration 0008: "Visibility lives in the database, never in
  // course.yaml, and re-import never touches it... New courses land hidden."
  // upsertCourse (import.ts) never mentions the `visibility` column on either
  // its INSERT (so the column's own `default 'hidden'` decides) or its
  // UPDATE (so there is nothing to re-derive from git on a sync) — these
  // tests are the acceptance criterion for both halves of that sentence.
  // ---------------------------------------------------------------------------

  it('a freshly imported course lands hidden — importing a repo can never expose anything', async () => {
    const slug = `${SLUG_PREFIX}-lands-hidden`;
    const dir = await writeCourse(path.join(tmp, 'lands-hidden'), {
      slug,
      modules: [{ id: 'm', title: 'M', lessons: [lesson('m/a.md', 'A')] }],
    });

    await importDir(dir);

    const row = await pool.query<{ visibility: string }>(`select visibility from courses where slug = $1`, [slug]);
    expect(row.rows[0]?.visibility).toBe('hidden');
  });

  it('re-import NEVER changes visibility: open survives a sync, and so does hidden', async () => {
    const slug = `${SLUG_PREFIX}-visibility-survives`;
    const dir = await writeCourse(path.join(tmp, 'visibility-survives'), {
      slug,
      modules: [{ id: 'm', title: 'M', lessons: [lesson('m/a.md', 'A')] }],
    });

    await importDir(dir);
    expect((await pool.query(`select visibility from courses where slug = $1`, [slug])).rows[0]?.visibility).toBe(
      'hidden',
    );

    // An admin publishes it — exactly what api/src/routes/courses.ts's PATCH
    // route does, but this test writes the column directly so it stays a
    // pure import.ts test rather than pulling in the HTTP layer.
    await pool.query(`update courses set visibility = 'open' where slug = $1`, [slug]);

    // A routine content sync — editing the lesson body is enough to prove
    // this isn't a no-op skip that happens to leave the column untouched.
    await writeCourse(dir, {
      slug,
      modules: [{ id: 'm', title: 'M', lessons: [lesson('m/a.md', 'A', 'Updated prose.')] }],
    });
    await importDir(dir);

    expect((await pool.query(`select visibility from courses where slug = $1`, [slug])).rows[0]?.visibility).toBe(
      'open',
    );

    // Now the owner takes it back down — re-import must leave THAT alone too.
    await pool.query(`update courses set visibility = 'hidden' where slug = $1`, [slug]);

    await writeCourse(dir, {
      slug,
      modules: [{ id: 'm', title: 'M', lessons: [lesson('m/a.md', 'A', 'Updated again.')] }],
    });
    await importDir(dir);

    expect((await pool.query(`select visibility from courses where slug = $1`, [slug])).rows[0]?.visibility).toBe(
      'hidden',
    );
  });

  it('is a no-op on re-import: every lesson id AND updated_at is unchanged', async () => {
    const slug = `${SLUG_PREFIX}-noop`;
    const dir = await writeCourse(path.join(tmp, 'noop'), {
      slug,
      tracks: [{ id: 'cx', name: 'Complexity', hue: 'blue' }],
      modules: [
        {
          id: 'intro',
          title: 'Introduction',
          lessons: [
            { file: 'modules/01/one.md', body: '---\ntitle: One\ntrack: cx\n---\n\nFirst.\n' },
            lesson('modules/01/two.md', 'Two'),
          ],
        },
      ],
    });

    await importDir(dir);
    const before = await lessonRows(slug);

    const result = await importDir(dir);

    expect(result.counts.lessons).toEqual({ created: 0, updated: 0, skipped: 2, archived: 0 });
    expect(result.counts.modules.updated).toBe(0);
    expect(result.counts.tracks.updated).toBe(0);
    expect(result.counts.courses.updated).toBe(0);

    const after = await lessonRows(slug);
    expect(after.map((l) => l.id)).toEqual(before.map((l) => l.id));
    expect(after.map((l) => l.updated_at.toISOString())).toEqual(before.map((l) => l.updated_at.toISOString()));
    expect(after.map((l) => l.created_at.toISOString())).toEqual(before.map((l) => l.created_at.toISOString()));
  });

  it('rewrites exactly one row when exactly one lesson changed', async () => {
    const slug = `${SLUG_PREFIX}-onerow`;
    const dirPath = path.join(tmp, 'onerow');
    const spec: CourseSpec = {
      slug,
      modules: [
        {
          id: 'intro',
          title: 'Introduction',
          lessons: [lesson('m/one.md', 'One'), lesson('m/two.md', 'Two'), lesson('m/three.md', 'Three')],
        },
      ],
    };
    await writeCourse(dirPath, spec);
    await importDir(dirPath);
    const before = await lessonRows(slug);

    // Edit the middle lesson only.
    await writeFile(path.join(dirPath, 'm/two.md'), '---\ntitle: Two\n---\n\nEdited prose.\n');
    const result = await importDir(dirPath);

    expect(result.counts.lessons).toEqual({ created: 0, updated: 1, skipped: 2, archived: 0 });

    const after = await lessonRows(slug);
    expect(after.map((l) => l.id)).toEqual(before.map((l) => l.id));

    const changed = after.filter(
      (l, i) => l.updated_at.toISOString() !== before[i]!.updated_at.toISOString(),
    );
    expect(changed.map((l) => l.lesson_key)).toEqual(['m/two']);
    expect(JSON.stringify(after[1]!.blocks)).toContain('Edited prose');
    expect(after[1]!.content_hash).not.toBe(before[1]!.content_hash);
  });

  it('archives a lesson dropped from the manifest instead of deleting it, and re-adding un-archives the same row', async () => {
    const slug = `${SLUG_PREFIX}-archive`;
    const dirPath = path.join(tmp, 'archive');
    const full: CourseSpec = {
      slug,
      modules: [
        { id: 'intro', title: 'Introduction', lessons: [lesson('m/one.md', 'One'), lesson('m/two.md', 'Two')] },
        { id: 'extra', title: 'Extra', lessons: [lesson('m2/three.md', 'Three')] },
      ],
    };
    await writeCourse(dirPath, full);
    await importDir(dirPath);
    const before = await lessonRows(slug);
    const twoId = before.find((l) => l.lesson_key === 'm/two')!.id;
    const threeId = before.find((l) => l.lesson_key === 'm2/three')!.id;

    // Drop lesson two, and the whole second module.
    await writeCourse(dirPath, {
      slug,
      modules: [{ id: 'intro', title: 'Introduction', lessons: [lesson('m/one.md', 'One')] }],
    });
    const removed = await importDir(dirPath);

    expect(removed.counts.lessons.archived).toBe(2);
    expect(removed.counts.modules.archived).toBe(1);

    const archived = await lessonRows(slug);
    expect(archived).toHaveLength(3); // nothing deleted
    const two = archived.find((l) => l.lesson_key === 'm/two')!;
    expect(two.id).toBe(twoId); // same row
    expect(two.archived_at).not.toBeNull();
    const three = archived.find((l) => l.lesson_key === 'm2/three')!;
    expect(three.id).toBe(threeId);
    expect(three.archived_at).not.toBeNull();
    // The lesson still in the manifest is untouched.
    expect(archived.find((l) => l.lesson_key === 'm/one')!.archived_at).toBeNull();

    const archivedModule = await pool.query(
      `select archived_at from modules m join courses c on c.id = m.course_id where c.slug = $1 and m.key = 'extra'`,
      [slug],
    );
    expect(archivedModule.rows[0].archived_at).not.toBeNull();

    // Put both back: same ids, archived_at cleared.
    await writeCourse(dirPath, full);
    const restored = await importDir(dirPath);
    expect(restored.counts.lessons.archived).toBe(0);

    const back = await lessonRows(slug);
    expect(back).toHaveLength(3);
    expect(back.find((l) => l.lesson_key === 'm/two')!.id).toBe(twoId);
    expect(back.find((l) => l.lesson_key === 'm/two')!.archived_at).toBeNull();
    expect(back.find((l) => l.lesson_key === 'm2/three')!.id).toBe(threeId);
    expect(back.find((l) => l.lesson_key === 'm2/three')!.archived_at).toBeNull();
  });

  it('lets a moved lesson file take the slug its archived predecessor still holds', async () => {
    const slug = `${SLUG_PREFIX}-moved`;
    const dirPath = path.join(tmp, 'moved');
    await writeCourse(dirPath, {
      slug,
      modules: [{ id: 'intro', title: 'Introduction', lessons: [lesson('01-intro/readme.md', 'Intro')] }],
    });
    await importDir(dirPath);
    const before = await lessonRows(slug);
    expect(before[0]!.slug).toBe('intro');

    // Same module, same filename, different directory: a NEW lesson identity
    // deriving the SAME slug, while the old row survives as an archived one.
    await writeCourse(dirPath, {
      slug,
      modules: [{ id: 'intro', title: 'Introduction', lessons: [lesson('1-intro/readme.md', 'Intro')] }],
    });
    await importDir(dirPath);

    const after = await lessonRows(slug);
    expect(after).toHaveLength(2);
    const live = after.filter((l) => l.archived_at === null);
    expect(live).toHaveLength(1);
    expect(live[0]!.lesson_key).toBe('1-intro/readme');
    expect(live[0]!.slug).toBe('intro');
    // The archived row is still there, still with its original id.
    const archived = after.find((l) => l.archived_at !== null)!;
    expect(archived.id).toBe(before[0]!.id);
    expect(archived.slug).toMatch(/^intro-archived-/);
  });

  it('rolls the whole course back when a lesson names a track that does not exist', async () => {
    const slug = `${SLUG_PREFIX}-rollback`;
    const dirPath = path.join(tmp, 'rollback');
    await writeCourse(dirPath, {
      slug,
      title: 'Good Version',
      tracks: [{ id: 'cx', name: 'Complexity', hue: 'blue' }],
      modules: [
        {
          id: 'intro',
          title: 'Introduction',
          lessons: [
            { file: 'm/one.md', body: '---\ntitle: One\ntrack: cx\n---\n\nFirst.\n' },
            lesson('m/two.md', 'Two'),
          ],
        },
      ],
    });
    await importDir(dirPath);
    const before = await snapshot(slug);
    const runsBefore = await importRuns(slug);

    // A second module whose FIRST lesson is fine and whose SECOND names a
    // track that is not declared: the failure happens after the course, the
    // tracks, both modules and three lessons have already been written inside
    // the transaction, so a partial commit would be visible.
    await writeCourse(dirPath, {
      slug,
      title: 'Broken Version',
      tracks: [{ id: 'cx', name: 'Complexity', hue: 'blue' }],
      modules: [
        {
          id: 'intro',
          title: 'Introduction Renamed',
          lessons: [
            { file: 'm/one.md', body: '---\ntitle: One Edited\ntrack: cx\n---\n\nEdited.\n' },
            lesson('m/two.md', 'Two Edited'),
          ],
        },
        {
          id: 'later',
          title: 'Later',
          lessons: [
            lesson('m2/ok.md', 'Fine'),
            { file: 'm2/bad.md', body: '---\ntitle: Bad\ntrack: nope\n---\n\nBroken.\n' },
          ],
        },
      ],
    });

    await expect(importDir(dirPath)).rejects.toThrow(/nope/);

    expect(await snapshot(slug)).toEqual(before);

    // ...but the audit trail survives the rollback.
    const runsAfter = await importRuns(slug);
    expect(runsAfter).toHaveLength(runsBefore.length + 1);
    const failed = runsAfter[runsAfter.length - 1];
    expect(failed.status).toBe('failed');
    expect(failed.finished_at).not.toBeNull();
    expect(failed.log.error.message).toMatch(/nope/);
  });

  // ---------------------------------------------------------------------------
  // Task A: a rubric criterion naming an undeclared track fails import, the
  // same way a lesson's frontmatter track does.
  // ---------------------------------------------------------------------------

  function rubricMarkdown(title: string, criteria: string): string {
    return `---\ntitle: ${title}\nkind: exercise\n---\n\nReview this.\n\n\`\`\`rubric\ncriteria:\n${criteria}\n\`\`\`\n`;
  }

  it('imports a rubric block whose criterion track IS declared in course.yaml', async () => {
    const slug = `${SLUG_PREFIX}-rubric-ok`;
    const dirPath = path.join(tmp, 'rubric-ok');
    await writeCourse(dirPath, {
      slug,
      tracks: [{ id: 'cx', name: 'Complexity', hue: 'blue' }],
      modules: [
        {
          id: 'exercises',
          title: 'Exercises',
          lessons: [
            {
              file: 'm/ex.md',
              body: rubricMarkdown('Ex One', '  - name: Spotted the shallow module\n    max: 5\n    track: cx'),
            },
          ],
        },
      ],
    });

    const result = await importDir(dirPath);
    expect(result.counts.lessons.created).toBe(1);

    const rows = await lessonRows(slug);
    const rubricBlock = (rows[0]!.blocks as Array<{ type: string; criteria?: unknown }>).find(
      (b) => b.type === 'rubric',
    );
    expect(rubricBlock).toEqual({
      type: 'rubric',
      criteria: [{ name: 'Spotted the shallow module', max: 5, track: 'cx' }],
    });
  });

  it('fails import with a clear message when a rubric criterion names a track not declared in course.yaml', async () => {
    const slug = `${SLUG_PREFIX}-rubric-bad-track`;
    const dirPath = path.join(tmp, 'rubric-bad-track');
    await writeCourse(dirPath, {
      slug,
      tracks: [{ id: 'cx', name: 'Complexity', hue: 'blue' }],
      modules: [
        {
          id: 'exercises',
          title: 'Exercises',
          lessons: [
            {
              file: 'm/ex.md',
              body: rubricMarkdown('Ex One', '  - name: Something\n    max: 5\n    track: not-a-real-track'),
            },
          ],
        },
      ],
    });

    await expect(importDir(dirPath)).rejects.toThrow(/not-a-real-track/);
    await expect(importDir(dirPath)).rejects.toThrow(/not declared in course\.yaml/);

    // Rolled back completely — same guarantee as the frontmatter-track case.
    const rows = await pool.query(`select 1 from courses where slug = $1`, [slug]);
    expect(rows.rowCount).toBe(0);
  });

  it('rejects two lessons that would collide on the same identity', async () => {
    const slug = `${SLUG_PREFIX}-dupe`;
    const dirPath = path.join(tmp, 'dupe');
    await writeCourse(dirPath, {
      slug,
      modules: [
        {
          id: 'intro',
          title: 'Introduction',
          lessons: [lesson('m/one.md', 'One'), lesson('m/one.md', 'One again')],
        },
      ],
    });

    await expect(importDir(dirPath)).rejects.toThrow(/twice|duplicate/i);
    const rows = await pool.query(`select 1 from courses where slug = $1`, [slug]);
    expect(rows.rowCount).toBe(0);
  });
});
