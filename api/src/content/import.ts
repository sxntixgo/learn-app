import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { LoadedCourse, LoadedLesson, LoadedModule, TrackDef } from './manifest.ts';
import type { Block } from './parse.ts';
import { validateBlocks } from './validate.ts';

// ---------------------------------------------------------------------------
// The import transaction (design §7 and §8).
//
// The one thing this module exists to guarantee: content is DERIVED state,
// user progress is not. A re-import may rewrite, reorder or hide any content
// row, but it must never make a `lesson_progress.lesson_id` written last month
// point at nothing. Everything below follows from that:
//
//   1. A lesson is upserted on its natural key `(module_id, lesson_key)`, and
//      its `id` is never reassigned. There is deliberately no DELETE + INSERT
//      path anywhere in this file — that is what would silently orphan
//      progress rows, and it would do it without raising a single error.
//   2. A lesson (or module) that disappears from the manifest is ARCHIVED, not
//      deleted; if it comes back it is un-archived and keeps its original id.
//   3. One transaction per course: the entire course is written inside a
//      single BEGIN/COMMIT, so a failure anywhere leaves the previously
//      imported version completely intact. Content gets edited while people
//      are reading it.
//   4. Unchanged lessons are not rewritten — `content_hash` decides — so a
//      one-line edit in an 86-file repo touches one row.
//
// The `import_runs` row is written OUTSIDE that transaction. See
// startImportRun below for why that is not an oversight.
// ---------------------------------------------------------------------------

/** Per-entity outcome of one import. `archived` is always 0 for courses and tracks. */
export interface EntityCounts {
  created: number;
  updated: number;
  skipped: number;
  archived: number;
}

export interface ImportCounts {
  courses: EntityCounts;
  tracks: EntityCounts;
  modules: EntityCounts;
  lessons: EntityCounts;
}

export interface ImportOptions {
  /**
   * The commit the content came from, recorded on `courses.imported_commit`
   * and `import_runs.commit_sha`. Null (the default) for an import from a
   * local directory, which is all Phase 2 does — git cloning is Phase 5.
   */
  commit?: string | null;
  /** The `content_repos` row this course came from, if any. Null for a local directory. */
  repoId?: string | null;
}

export interface ImportResult {
  importRunId: string;
  courseId: string;
  slug: string;
  counts: ImportCounts;
}

// Arbitrary fixed classid for this app's per-course import lock; pairs with
// hashtext(slug) as the second key. Distinct from migrate.ts's lock key.
const ADVISORY_LOCK_CLASS = 727_284_914;

function noCounts(): EntityCounts {
  return { created: 0, updated: 0, skipped: 0, archived: 0 };
}

/**
 * Imports an already-loaded course into the database.
 *
 * Parsing and writing stay separate on purpose: `loadCourse(dir)` produces the
 * `LoadedCourse` and touches no database, this touches no filesystem. That is
 * what lets validate-only mode (design §8) run the identical parse the
 * importer will run, and what will let Phase 5 hand this function a course
 * parsed out of a git clone with no change here.
 *
 * Throws on any problem, having first rolled back every content write and
 * recorded a `failed` import_runs row. The caller gets a real error rather
 * than a result object because a half-understood failure here is exactly the
 * thing that corrupts history quietly.
 */
export async function importCourse(
  client: pg.PoolClient,
  course: LoadedCourse,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const commit = opts.commit ?? null;
  const repoId = opts.repoId ?? null;

  const importRunId = await startImportRun(client, course.slug, repoId, commit);

  try {
    const { courseId, counts } = await withTransaction(client, () =>
      writeCourse(client, course, repoId, commit),
    );
    await finishImportRun(client, importRunId, 'success', { counts });
    return { importRunId, courseId, slug: course.slug, counts };
  } catch (err) {
    // Never let a bookkeeping failure mask the failure that caused it: if the
    // connection itself is what broke, this UPDATE throws too, and the caller
    // needs the ORIGINAL error. The run then stays 'running', which is the
    // honest record of a process that died mid-import.
    try {
      await finishImportRun(client, importRunId, 'failed', { error: describeError(err) });
    } catch {
      // Reported by leaving the run row as 'running'; the real error follows.
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The audit trail
// ---------------------------------------------------------------------------

/**
 * Opens the `import_runs` row, OUTSIDE the course transaction.
 *
 * This is the whole point of the row: an import_runs entry that is rolled back
 * along with the failure it records is not an audit trail, it is a record of
 * successes — and the run an admin most needs to read is the one that failed.
 * So the row is INSERTed (and committed, since the connection is still in
 * autocommit at this point) before BEGIN, and UPDATEd after COMMIT or
 * ROLLBACK, on the same connection.
 *
 * It is opened as `status = 'running'` rather than written once at the end so
 * that a process killed mid-import leaves visible evidence instead of nothing
 * — which is also why 0002 gave `status` that default.
 *
 * `course_slug` rather than a course id: a first import that fails rolls the
 * `courses` row back with everything else, so there would be no id to point at
 * in precisely the case the log matters most (0003 adds the column).
 */
async function startImportRun(
  client: pg.PoolClient,
  slug: string,
  repoId: string | null,
  commit: string | null,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into import_runs (repo_id, course_slug, commit_sha, status)
     values ($1, $2, $3, 'running')
     returning id`,
    [repoId, slug, commit],
  );
  return rows[0]!.id;
}

async function finishImportRun(
  client: pg.PoolClient,
  id: string,
  status: 'success' | 'failed',
  log: unknown,
): Promise<void> {
  await client.query(
    `update import_runs set status = $2, finished_at = now(), log = $3::jsonb where id = $1`,
    [id, status, JSON.stringify(log)],
  );
}

function describeError(err: unknown): { message: string; name?: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return { message: String(err) };
}

async function withTransaction<T>(client: pg.PoolClient, fn: () => Promise<T>): Promise<T> {
  await client.query('begin');
  try {
    const result = await fn();
    await client.query('commit');
    return result;
  } catch (err) {
    try {
      await client.query('rollback');
    } catch {
      // The connection is already unusable; the server rolls back an
      // abandoned transaction on its own. Report the original failure.
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Planning: everything derivable from the manifest, before any write
// ---------------------------------------------------------------------------

interface PlannedLesson {
  lessonKey: string;
  slug: string;
  title: string;
  kind: string;
  estimateMinutes: number | null;
  trackKey: string | null;
  position: number;
  sourcePath: string;
  blocks: Block[];
  contentHash: string;
}

interface PlannedModule {
  key: string;
  title: string;
  position: number;
  lessons: PlannedLesson[];
}

/**
 * A lesson's durable identity within its module.
 *
 * The manifest gives a lesson no id of its own — only the path it lives at
 * (design §6.1) — so the path, minus its extension, IS the identity. Using the
 * full course-relative path rather than the bare filename means two lessons in
 * the same module can legitimately be called `README.md` in different
 * directories without one silently taking over the other's row (and with it,
 * every progress record pointing at it).
 */
function lessonKeyFor(srcPath: string): string {
  return srcPath.replace(/\\/g, '/').replace(/\.[^./]*$/, '');
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The human-facing `(course_id, slug)` lookup key — distinct from lesson_key,
 * which is the durable import identity.
 *
 * Prefixed with the module key because filenames repeat constantly across a
 * real content repo (every directory has a README.md) while the slug must be
 * unique per course. A module-index file collapses to just the module key, so
 * `modules/01-intro/README.md` reads as `/intro` rather than `/intro-readme`.
 */
function lessonSlugFor(moduleKey: string, srcPath: string): string {
  const base = slugify(srcPath.split('/').pop()!.replace(/\.[^./]*$/, ''));
  if (base === '' || base === 'readme' || base === 'index') return slugify(moduleKey);
  return `${slugify(moduleKey)}-${base}`;
}

/**
 * Hash of everything this import would write into the lesson row, excluding
 * its identity columns. Equality means "re-writing this row would change
 * nothing", which is exactly the condition for skipping it — so `position` and
 * `slug` are in here alongside the blocks: a reordered lesson is a changed row
 * even when its prose is untouched.
 */
function hashLesson(fields: Omit<PlannedLesson, 'contentHash' | 'lessonKey'>): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        fields.slug,
        fields.title,
        fields.kind,
        fields.estimateMinutes,
        fields.trackKey,
        fields.position,
        fields.sourcePath,
        fields.blocks,
      ]),
    )
    .digest('hex');
}

function planLesson(moduleKey: string, lesson: LoadedLesson, position: number): PlannedLesson {
  const fields = {
    slug: lessonSlugFor(moduleKey, lesson.srcPath),
    title: lesson.title,
    kind: lesson.kind,
    estimateMinutes: lesson.estimateMinutes ?? null,
    trackKey: lesson.track ?? null,
    position,
    sourcePath: lesson.srcPath,
    blocks: lesson.blocks,
  };
  return { lessonKey: lessonKeyFor(lesson.srcPath), ...fields, contentHash: hashLesson(fields) };
}

/**
 * Turns the loaded course into the exact rows to write, and rejects a manifest
 * that cannot be represented: duplicate module keys, a lesson listed twice in
 * one module, two lessons colliding on the same slug, or blocks that do not
 * validate.
 *
 * Catching these here rather than letting Postgres raise a unique violation
 * mid-write is purely about error quality (design §8) — the transaction would
 * have kept the database safe either way, but `23505 duplicate key value` does
 * not tell an author which two files to look at.
 */
function planCourse(course: LoadedCourse): PlannedModule[] {
  const modules: PlannedModule[] = [];
  const seenModuleKeys = new Set<string>();
  const slugOwner = new Map<string, string>();

  course.modules.forEach((mod: LoadedModule, moduleIndex) => {
    if (seenModuleKeys.has(mod.id)) {
      throw new Error(`course.yaml: module "${mod.id}" is declared twice.`);
    }
    seenModuleKeys.add(mod.id);

    const seenLessonKeys = new Set<string>();
    const lessons = mod.lessons.map((lesson, lessonIndex) => {
      const planned = planLesson(mod.id, lesson, lessonIndex);

      if (seenLessonKeys.has(planned.lessonKey)) {
        throw new Error(`${lesson.srcPath}: listed twice in module "${mod.id}" — a duplicate lesson identity.`);
      }
      seenLessonKeys.add(planned.lessonKey);

      const owner = slugOwner.get(planned.slug);
      if (owner !== undefined) {
        throw new Error(
          `${lesson.srcPath}: derives the same lesson slug "${planned.slug}" as ${owner}. ` +
            `Slugs must be unique within a course — rename one of the two files.`,
        );
      }
      slugOwner.set(planned.slug, lesson.srcPath);

      const blocksResult = validateBlocks(planned.blocks);
      if (!blocksResult.valid) {
        const detail = blocksResult.errors.map((e) => `${lesson.srcPath}:${e.path}: ${e.message}`).join('\n');
        throw new Error(`invalid blocks, refusing to write:\n${detail}`);
      }

      return planned;
    });

    modules.push({ key: mod.id, title: mod.title, position: moduleIndex, lessons });
  });

  return modules;
}

// ---------------------------------------------------------------------------
// Writing (all of this runs inside the one transaction)
// ---------------------------------------------------------------------------

async function writeCourse(
  client: pg.PoolClient,
  course: LoadedCourse,
  repoId: string | null,
  commit: string | null,
): Promise<{ courseId: string; counts: ImportCounts }> {
  const planned = planCourse(course);

  // Serialise concurrent imports of the SAME course (different courses do not
  // block each other). Without this, two overlapping imports could interleave
  // such that one's archive pass archives lessons the other just wrote. Held
  // until the transaction ends, released automatically on rollback.
  await client.query(`select pg_advisory_xact_lock($1, hashtext($2))`, [ADVISORY_LOCK_CLASS, course.slug]);

  const counts: ImportCounts = {
    courses: noCounts(),
    tracks: noCounts(),
    modules: noCounts(),
    lessons: noCounts(),
  };

  const courseId = await upsertCourse(client, course, repoId, commit, counts.courses);
  const trackIds = await upsertTracks(client, courseId, course.tracks, counts.tracks);

  const existingLessons = await loadExistingLessons(client, courseId);

  // Modules first, and all of them: a lesson's identity is
  // (module_id, lesson_key), so every module id has to exist before any lesson
  // can be matched to the row it is updating.
  const moduleIds = new Map<string, string>();
  for (const mod of planned) {
    moduleIds.set(mod.key, await upsertModule(client, courseId, mod, counts.modules));
  }

  // Which existing rows this import will reuse — knowable before a single
  // lesson is written, because identity is a pure function of the manifest.
  // Every other lesson row is on its way to being archived, and must give up
  // any slug the new content wants BEFORE that content is written.
  const reusedLessonIds: string[] = [];
  for (const mod of planned) {
    for (const lesson of mod.lessons) {
      const existing = existingLessons.get(lessonIdentity(moduleIds.get(mod.key)!, lesson.lessonKey));
      if (existing !== undefined) reusedLessonIds.push(existing.id);
    }
  }
  await releaseSlugsFromDepartingLessons(client, courseId, planned, reusedLessonIds);

  const keptLessonIds: string[] = [];
  for (const mod of planned) {
    const moduleId = moduleIds.get(mod.key)!;
    for (const lesson of mod.lessons) {
      const id = await upsertLesson(client, {
        courseId,
        moduleId,
        lesson,
        trackIds,
        existing: existingLessons.get(lessonIdentity(moduleId, lesson.lessonKey)),
        counts: counts.lessons,
      });
      keptLessonIds.push(id);
    }
  }

  counts.modules.archived = await archiveMissingModules(client, courseId, planned);
  counts.lessons.archived = await archiveMissingLessons(client, courseId, keptLessonIds);

  return { courseId, counts };
}

async function upsertCourse(
  client: pg.PoolClient,
  course: LoadedCourse,
  repoId: string | null,
  commit: string | null,
  counts: EntityCounts,
): Promise<string> {
  const tags = course.tags ?? [];
  const subtitle = course.subtitle ?? null;
  const description = course.description ?? null;

  const existing = await client.query<{
    id: string;
    title: string;
    subtitle: string | null;
    description: string | null;
    tags: string[];
    imported_commit: string | null;
    repo_id: string | null;
  }>(
    `select id, title, subtitle, description, tags, imported_commit, repo_id from courses where slug = $1`,
    [course.slug],
  );

  const row = existing.rows[0];
  if (row === undefined) {
    const inserted = await client.query<{ id: string }>(
      `insert into courses (repo_id, slug, title, subtitle, description, tags, imported_commit)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id`,
      [repoId, course.slug, course.title, subtitle, description, tags, commit],
    );
    counts.created++;
    return inserted.rows[0]!.id;
  }

  const unchanged =
    row.title === course.title &&
    row.subtitle === subtitle &&
    row.description === description &&
    JSON.stringify(row.tags) === JSON.stringify(tags) &&
    row.imported_commit === commit &&
    row.repo_id === repoId;

  if (unchanged) {
    counts.skipped++;
    return row.id;
  }

  await client.query(
    `update courses
        set repo_id = $2, title = $3, subtitle = $4, description = $5, tags = $6,
            imported_commit = $7, updated_at = now()
      where id = $1`,
    [row.id, repoId, course.title, subtitle, description, tags, commit],
  );
  counts.updated++;
  return row.id;
}

/**
 * Upserts the manifest's tracks on `(course_id, key)` and returns key → id.
 *
 * Tracks that exist in the database but not in the manifest are deliberately
 * left alone rather than deleted: `tracks.id` is a foreign key target for
 * future user data (design §7 puts `track_id` on both `quiz_attempts` and
 * `rubric_scores`), so deleting one would discard user history to tidy up
 * derived state — the exact trade this schema is built to refuse. Nothing
 * references a removed track anyway, because a lesson naming a track the
 * manifest does not declare fails the import outright.
 */
async function upsertTracks(
  client: pg.PoolClient,
  courseId: string,
  tracks: TrackDef[],
  counts: EntityCounts,
): Promise<Map<string, string>> {
  const existing = await client.query<{
    id: string;
    key: string;
    name: string;
    hue: string;
    blurb: string | null;
    position: number;
  }>(`select id, key, name, hue, blurb, position from tracks where course_id = $1`, [courseId]);
  const byKey = new Map(existing.rows.map((r) => [r.key, r]));

  const ids = new Map<string, string>(existing.rows.map((r) => [r.key, r.id]));

  for (const [position, track] of tracks.entries()) {
    const blurb = track.blurb ?? null;
    const row = byKey.get(track.id);

    if (row === undefined) {
      const inserted = await client.query<{ id: string }>(
        `insert into tracks (course_id, key, name, hue, blurb, position)
         values ($1, $2, $3, $4, $5, $6)
         returning id`,
        [courseId, track.id, track.name, track.hue, blurb, position],
      );
      ids.set(track.id, inserted.rows[0]!.id);
      counts.created++;
      continue;
    }

    if (row.name === track.name && row.hue === track.hue && row.blurb === blurb && row.position === position) {
      counts.skipped++;
      continue;
    }

    await client.query(`update tracks set name = $2, hue = $3, blurb = $4, position = $5 where id = $1`, [
      row.id,
      track.name,
      track.hue,
      blurb,
      position,
    ]);
    counts.updated++;
  }

  return ids;
}

async function upsertModule(
  client: pg.PoolClient,
  courseId: string,
  mod: PlannedModule,
  counts: EntityCounts,
): Promise<string> {
  const existing = await client.query<{
    id: string;
    title: string;
    position: number;
    archived_at: Date | null;
  }>(`select id, title, position, archived_at from modules where course_id = $1 and key = $2`, [
    courseId,
    mod.key,
  ]);

  const row = existing.rows[0];
  if (row === undefined) {
    const inserted = await client.query<{ id: string }>(
      `insert into modules (course_id, key, title, position) values ($1, $2, $3, $4) returning id`,
      [courseId, mod.key, mod.title, mod.position],
    );
    counts.created++;
    return inserted.rows[0]!.id;
  }

  if (row.title === mod.title && row.position === mod.position && row.archived_at === null) {
    counts.skipped++;
    return row.id;
  }

  // archived_at is cleared unconditionally: a module back in the manifest is
  // live again, and keeps its id (and therefore its lessons).
  await client.query(`update modules set title = $2, position = $3, archived_at = null where id = $1`, [
    row.id,
    mod.title,
    mod.position,
  ]);
  counts.updated++;
  return row.id;
}

interface ExistingLesson {
  id: string;
  module_id: string;
  lesson_key: string;
  slug: string;
  source_path: string;
  content_hash: string;
  track_id: string | null;
  archived_at: Date | null;
}

/** Map key for the natural lesson identity `(module_id, lesson_key)`. */
function lessonIdentity(moduleId: string, lessonKey: string): string {
  return `${moduleId}\n${lessonKey}`;
}

async function loadExistingLessons(
  client: pg.PoolClient,
  courseId: string,
): Promise<Map<string, ExistingLesson>> {
  const { rows } = await client.query<ExistingLesson>(
    `select id, module_id, lesson_key, slug, source_path, content_hash, track_id, archived_at
       from lessons where course_id = $1`,
    [courseId],
  );
  return new Map(rows.map((r) => [lessonIdentity(r.module_id, r.lesson_key), r]));
}

/**
 * Task A: refuses a rubric criterion that names a track this course.yaml
 * does not declare. Walks every `rubric` block in the lesson (there is
 * ordinarily at most one, but nothing stops a document having more) rather
 * than assuming block position, since content authoring is otherwise free
 * to interleave rubric and prose/code blocks however the lesson reads best.
 *
 * KNOWN GAP, stated rather than silently extended: quiz questions (Phase 7)
 * carry the identical optional `track` field and are NOT checked here or
 * anywhere else in the importer — a pre-existing hole this task was not
 * asked to close. Closing it would be the same one-line shape as this
 * function, applied to `quizBlock.questions[].track` instead of
 * `rubricBlock.criteria[].track`.
 */
function validateRubricTracks(sourcePath: string, blocks: Block[], trackIds: Map<string, string>): void {
  for (const block of blocks) {
    if (block.type !== 'rubric') continue;
    for (const criterion of block.criteria) {
      if (criterion.track === undefined) continue;
      if (!trackIds.has(criterion.track)) {
        const known = [...trackIds.keys()];
        throw new Error(
          `${sourcePath}: rubric criterion "${criterion.name}" names track "${criterion.track}" which is ` +
            `not declared in course.yaml (declared tracks: ${known.length > 0 ? known.join(', ') : 'none'}).`,
        );
      }
    }
  }
}

async function upsertLesson(
  client: pg.PoolClient,
  args: {
    courseId: string;
    moduleId: string;
    lesson: PlannedLesson;
    trackIds: Map<string, string>;
    existing: ExistingLesson | undefined;
    counts: EntityCounts;
  },
): Promise<string> {
  const { courseId, moduleId, lesson, trackIds, existing, counts } = args;

  // An unknown track is an error, never a silent null: a lesson quietly losing
  // its lens is the kind of damage nobody notices until the course is live.
  // Resolved here at the point of use rather than in a pre-pass, so the error
  // names the file — the surrounding transaction is what makes failing this
  // late safe.
  let trackId: string | null = null;
  if (lesson.trackKey !== null) {
    const resolved = trackIds.get(lesson.trackKey);
    if (resolved === undefined) {
      const known = [...trackIds.keys()];
      throw new Error(
        `${lesson.sourcePath}: frontmatter track "${lesson.trackKey}" is not declared in course.yaml ` +
          `(declared tracks: ${known.length > 0 ? known.join(', ') : 'none'}).`,
      );
    }
    trackId = resolved;
  }

  // Task A: "a criterion referencing a track not declared in course.yaml
  // must fail import with a clear message, the same way a lesson's
  // frontmatter track does" — same trackIds map, same place, same style of
  // error, just walking the lesson's rubric block(s) instead of its
  // frontmatter. (Quiz questions carry an equally optional `track` and are
  // NOT validated here — a pre-existing gap in the Phase 7 quiz block that
  // this task does not extend to fix; see the module-level note above
  // upsertTracks for why the schema already anticipates rubric_scores
  // needing the same track_id foreign key quiz_attempts has.)
  validateRubricTracks(lesson.sourcePath, lesson.blocks, trackIds);

  const blocksJson = JSON.stringify(lesson.blocks);

  if (existing === undefined) {
    const inserted = await client.query<{ id: string }>(
      `insert into lessons (course_id, module_id, track_id, lesson_key, slug, title, kind,
                            estimate_minutes, position, source_path, content_hash, blocks)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
       returning id`,
      [
        courseId,
        moduleId,
        trackId,
        lesson.lessonKey,
        lesson.slug,
        lesson.title,
        lesson.kind,
        lesson.estimateMinutes,
        lesson.position,
        lesson.sourcePath,
        lesson.contentHash,
        blocksJson,
      ],
    );
    counts.created++;
    return inserted.rows[0]!.id;
  }

  // The skip that makes a re-import cheap. track_id and archived_at are
  // compared as well as the hash: neither is derived from the lesson file, so
  // an un-archive or a re-pointed track must still write even when the content
  // is byte-identical.
  if (
    existing.content_hash === lesson.contentHash &&
    existing.archived_at === null &&
    existing.track_id === trackId
  ) {
    counts.skipped++;
    return existing.id;
  }

  // UPDATE by id, never delete-and-reinsert: the row id is what every future
  // lesson_progress row points at.
  await client.query(
    `update lessons
        set module_id = $2, track_id = $3, slug = $4, title = $5, kind = $6, estimate_minutes = $7,
            position = $8, source_path = $9, content_hash = $10, blocks = $11::jsonb,
            archived_at = null, updated_at = now()
      where id = $1`,
    [
      existing.id,
      moduleId,
      trackId,
      lesson.slug,
      lesson.title,
      lesson.kind,
      lesson.estimateMinutes,
      lesson.position,
      lesson.sourcePath,
      lesson.contentHash,
      blocksJson,
    ],
  );
  counts.updated++;
  return existing.id;
}

/**
 * Frees a slug held by a lesson this import is leaving behind, so the lesson
 * that now wants it can have it.
 *
 * `unique (course_id, slug)` covers archived rows too, so moving a file —
 * `01-intro/readme.md` → `1-intro/readme.md`, a new identity deriving the same
 * pretty slug — would otherwise abort the import on a unique violation.
 * Renaming the departing row's slug is safe in a way that deleting the row
 * would not be: the row, its id, and everything pointing at it survive, and an
 * archived lesson is not reachable by slug anyway. The suffix comes from the
 * row's own id, so re-running the import is idempotent.
 */
async function releaseSlugsFromDepartingLessons(
  client: pg.PoolClient,
  courseId: string,
  planned: PlannedModule[],
  keptLessonIds: string[],
): Promise<void> {
  const wantedSlugs = planned.flatMap((m) => m.lessons.map((l) => l.slug));
  if (wantedSlugs.length === 0) return;

  const { rows } = await client.query<{ id: string; slug: string }>(
    `select id, slug from lessons
      where course_id = $1 and slug = any($2::text[]) and id <> all($3::uuid[])`,
    [courseId, wantedSlugs, keptLessonIds],
  );

  for (const row of rows) {
    await client.query(`update lessons set slug = $2, updated_at = now() where id = $1`, [
      row.id,
      `${row.slug}-archived-${row.id.slice(0, 8)}`,
    ]);
  }
}

async function archiveMissingModules(
  client: pg.PoolClient,
  courseId: string,
  planned: PlannedModule[],
): Promise<number> {
  const keys = planned.map((m) => m.key);
  const { rowCount } = await client.query(
    `update modules set archived_at = now()
      where course_id = $1 and archived_at is null and key <> all($2::text[])`,
    [courseId, keys],
  );
  return rowCount ?? 0;
}

/**
 * Archives every lesson of this course the manifest no longer lists — by
 * elimination against the ids just written, so a lesson whose module vanished
 * is caught too.
 *
 * This is an UPDATE. There is no DELETE here and there must never be one: a
 * deleted lesson takes every progress row, submission and annotation
 * referencing it with it, and does so silently.
 */
async function archiveMissingLessons(
  client: pg.PoolClient,
  courseId: string,
  keptLessonIds: string[],
): Promise<number> {
  const { rowCount } = await client.query(
    `update lessons set archived_at = now(), updated_at = now()
      where course_id = $1 and archived_at is null and id <> all($2::uuid[])`,
    [courseId, keptLessonIds],
  );
  return rowCount ?? 0;
}
