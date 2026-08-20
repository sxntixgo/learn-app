import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { can, type Actor, type CourseVisibility } from '../policy/can.ts';
import { searchLessons } from './query.ts';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is not set — required to run search/query.test.ts');
}

const { Pool } = pg;
const pool = new Pool({ connectionString });

/** Everything this file creates is tagged with this prefix so cleanup is exact. */
const TAG = 'srchq';

const STUDENT_ID = randomUUID();
const OTHER_OWNER_ID = randomUUID();
const student: Actor = { id: STUDENT_ID, roles: ['student'] };

interface SeededCourse {
  slug: string;
  lessonSlug: string;
}

async function makeCourse(opts: {
  key: string;
  visibility: CourseVisibility;
  ownerId: string | null;
  lessonTitle?: string;
  proseHtml?: string;
  lessonArchived?: boolean;
  moduleArchived?: boolean;
}): Promise<SeededCourse> {
  const slug = `${TAG}-${opts.key}`;
  const course = await pool.query<{ id: string }>(
    `insert into courses (slug, title, visibility, owner_id) values ($1, $2, $3, $4) returning id`,
    [slug, `Course ${opts.key}`, opts.visibility, opts.ownerId],
  );
  const courseId = course.rows[0]!.id;

  const module = await pool.query<{ id: string }>(
    `insert into modules (course_id, key, title, position, archived_at)
     values ($1, $2, $3, 0, $4) returning id`,
    [courseId, `${TAG}-m`, 'Module', opts.moduleArchived ? new Date() : null],
  );
  const moduleId = module.rows[0]!.id;

  const blocks = JSON.stringify([
    { type: 'prose', html: opts.proseHtml ?? '<p>Ordinary prose about photosynthesis.</p>' },
    { type: 'code', html: '<pre>chlorophyllcodeonly</pre>', code: 'chlorophyllcodeonly' },
  ]);

  const lessonSlug = `${slug}-lesson`;
  await pool.query(
    `insert into lessons (course_id, module_id, lesson_key, slug, title, source_path, content_hash, blocks, position, archived_at)
     values ($1, $2, $3, $3, $4, 'x', $5, $6::jsonb, 0, $7)`,
    [
      courseId,
      moduleId,
      lessonSlug,
      opts.lessonTitle ?? `Lesson ${opts.key}`,
      randomUUID(),
      blocks,
      opts.lessonArchived ? new Date() : null,
    ],
  );

  return { slug, lessonSlug };
}

function slugsIn(groups: Awaited<ReturnType<typeof searchLessons>>['groups']): string[] {
  return groups.flatMap((group) => group.lessons.map((lesson) => lesson.lessonSlug));
}

describe('lesson search (design §16, plan Phase 16)', () => {
  beforeAll(async () => {
    await pool.query(`delete from courses where slug like $1`, [`${TAG}-%`]);
    // courses.owner_id is a real FK, so the two owners have to exist as rows.
    // They carry no roles: ownership is a courses column, and the actor's
    // roles come from the Actor passed to can()/searchLessons, not from here.
    for (const id of [STUDENT_ID, OTHER_OWNER_ID]) {
      await pool.query(`insert into users (id, display_name) values ($1, $2) on conflict (id) do nothing`, [
        id,
        `${TAG} owner`,
      ]);
    }
  });

  afterAll(async () => {
    await pool.query(`delete from courses where slug like $1`, [`${TAG}-%`]);
    await pool.query(`delete from users where id = any($1::uuid[])`, [[STUDENT_ID, OTHER_OWNER_ID]]);
    await pool.end();
  });

  it('finds a lesson by a word in its title', async () => {
    const { lessonSlug } = await makeCourse({ key: 'title', visibility: 'open', ownerId: null, lessonTitle: 'Photosynthesis basics' });
    const results = await searchLessons(pool, student, { q: 'photosynthesis' });
    expect(slugsIn(results.groups)).toContain(lessonSlug);
  });

  it('finds a lesson by a word in its prose', async () => {
    const { lessonSlug } = await makeCourse({
      key: 'prose',
      visibility: 'open',
      ownerId: null,
      lessonTitle: 'Nothing in the title',
      proseHtml: '<p>The mitochondrion is the powerhouse.</p>',
    });
    const results = await searchLessons(pool, student, { q: 'mitochondrion' });
    expect(slugsIn(results.groups)).toContain(lessonSlug);
  });

  it('does not match text that appears only in a code block', async () => {
    await makeCourse({ key: 'code', visibility: 'open', ownerId: null });
    const results = await searchLessons(pool, student, { q: 'chlorophyllcodeonly' });
    expect(slugsIn(results.groups)).toEqual([]);
  });

  it('does not match HTML tag or attribute names from the prose', async () => {
    await makeCourse({
      key: 'tags',
      visibility: 'open',
      ownerId: null,
      lessonTitle: 'Markup free',
      proseHtml: '<p class="intro"><strong>Plain</strong> words only.</p>',
    });
    const results = await searchLessons(pool, student, { q: 'intro' });
    expect(slugsIn(results.groups)).toEqual([]);
  });

  // ---- the exclusions the plan names, one test each -------------------------

  it('excludes an archived lesson', async () => {
    const { lessonSlug } = await makeCourse({
      key: 'archlesson',
      visibility: 'open',
      ownerId: null,
      lessonTitle: 'Photosynthesis archived',
      lessonArchived: true,
    });
    const results = await searchLessons(pool, student, { q: 'photosynthesis' });
    expect(slugsIn(results.groups)).not.toContain(lessonSlug);
  });

  it('excludes a lesson whose module is archived', async () => {
    const { lessonSlug } = await makeCourse({
      key: 'archmodule',
      visibility: 'open',
      ownerId: null,
      lessonTitle: 'Photosynthesis in an archived module',
      moduleArchived: true,
    });
    const results = await searchLessons(pool, student, { q: 'photosynthesis' });
    expect(slugsIn(results.groups)).not.toContain(lessonSlug);
  });

  it('excludes a hidden course the actor does not own', async () => {
    const { lessonSlug } = await makeCourse({
      key: 'hidden',
      visibility: 'hidden',
      ownerId: OTHER_OWNER_ID,
      lessonTitle: 'Photosynthesis secret',
    });
    const results = await searchLessons(pool, student, { q: 'photosynthesis' });
    expect(slugsIn(results.groups)).not.toContain(lessonSlug);
  });

  it('includes a hidden course the actor owns', async () => {
    const { lessonSlug } = await makeCourse({
      key: 'ownhidden',
      visibility: 'hidden',
      ownerId: STUDENT_ID,
      lessonTitle: 'Photosynthesis mine',
    });
    const results = await searchLessons(pool, student, { q: 'photosynthesis' });
    expect(slugsIn(results.groups)).toContain(lessonSlug);
  });

  /**
   * The one that matters. Every other test here checks a case someone thought
   * of; this checks the property those cases are examples of — that the SQL
   * filter and `can(actor, 'lesson:read', ...)` are the same rule.
   *
   * Search is a second place where visibility gets decided, and a second
   * implementation of a security rule is how private content leaks: not
   * because someone writes the wrong rule, but because someone later changes
   * one copy. This fails the moment the two disagree for any combination.
   */
  it('returns exactly the lessons can() would permit, for every visibility and ownership', async () => {
    const visibilities: CourseVisibility[] = ['open', 'restricted', 'hidden'];
    const expected: string[] = [];

    for (const visibility of visibilities) {
      for (const owned of [true, false]) {
        const ownerId = owned ? STUDENT_ID : OTHER_OWNER_ID;
        const key = `equiv-${visibility}-${owned ? 'own' : 'other'}`;
        const { lessonSlug } = await makeCourse({
          key,
          visibility,
          ownerId,
          lessonTitle: 'Equivalence photosynthesis',
        });
        if (can(student, 'lesson:read', { course: { ownerId, visibility } })) {
          expected.push(lessonSlug);
        }
      }
    }

    const results = await searchLessons(pool, student, { q: 'equivalence' });
    const found = slugsIn(results.groups).filter((slug) => slug.includes('equiv-'));
    expect(found.sort()).toEqual(expected.sort());
  });

  // ---- shape and safety -----------------------------------------------------

  it('treats a blank query as no results rather than an error', async () => {
    for (const q of ['', '   ', '\n\t']) {
      const results = await searchLessons(pool, student, { q });
      expect(results.groups).toEqual([]);
    }
  });

  it('does not fail on punctuation a user might reasonably type', async () => {
    for (const q of ["photosynthesis's", 'photo & synthesis', '"unclosed quote', 'a | b', '!!!']) {
      await expect(searchLessons(pool, student, { q })).resolves.toBeDefined();
    }
  });

  it('groups hits under their course, with the course title', async () => {
    const { slug } = await makeCourse({ key: 'group', visibility: 'open', ownerId: null, lessonTitle: 'Grouping photosynthesis' });
    const results = await searchLessons(pool, student, { q: 'grouping' });
    const group = results.groups.find((candidate) => candidate.courseSlug === slug);
    expect(group).toBeDefined();
    expect(group!.courseTitle).toBe('Course group');
    expect(group!.lessons.length).toBeGreaterThan(0);
  });

  it('marks the matched term in the snippet and escapes everything else', async () => {
    await makeCourse({
      key: 'snippet',
      visibility: 'open',
      ownerId: null,
      lessonTitle: 'Snippet source',
      // The angle brackets survive tag-stripping as literal text, so they are
      // exactly the case where an unescaped snippet would inject markup.
      proseHtml: '<p>Comparing 3 &lt; 5 with xylophonics and more xylophonics text here.</p>',
    });
    const results = await searchLessons(pool, student, { q: 'xylophonics' });
    const hit = results.groups.flatMap((group) => group.lessons).find((lesson) => lesson.title === 'Snippet source');
    expect(hit).toBeDefined();
    expect(hit!.snippet).toContain('<mark>');
    // Nothing but <mark>/</mark> may be markup: strip those, and no raw
    // angle bracket may remain.
    const withoutMarks = hit!.snippet.replaceAll('<mark>', '').replaceAll('</mark>', '');
    expect(withoutMarks).not.toMatch(/[<>]/);

    // It is the MATCHED TERM that is marked, and only it. Without this, an
    // empty MARK_START sentinel would make `replaceAll` insert a <mark>
    // between every character — and every assertion above would still pass,
    // since stripping all those tags leaves clean text containing "<mark>".
    expect(hit!.snippet).toMatch(/<mark>xylophonics<\/mark>/i);
    expect(hit!.snippet.match(/<mark>/g) ?? []).toHaveLength(
      hit!.snippet.match(/<\/mark>/g)?.length ?? 0,
    );
    expect((hit!.snippet.match(/<mark>/g) ?? []).length).toBeLessThan(withoutMarks.length / 4);
  });

  it('honours the limit', async () => {
    for (const n of [1, 2, 3]) {
      await makeCourse({ key: `limit${n}`, visibility: 'open', ownerId: null, lessonTitle: `Limitium lesson ${n}` });
    }
    const results = await searchLessons(pool, student, { q: 'limitium', limit: 2 });
    expect(slugsIn(results.groups)).toHaveLength(2);
  });
});
