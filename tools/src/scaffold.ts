import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify as stringifyYaml } from 'yaml';
import { parseLesson } from '@learn/api/content/parse';
import type { CourseManifest, ModuleDef } from '@learn/api/content/manifest';

// `scaffold` drafts a course.yaml from an existing repo tree (design §6.1:
// "course.yaml owns structure and order"). Its output is a FIRST DRAFT a
// human then edits, not a finished manifest — see the module docstrings
// below for the specific things it deliberately refuses to guess (tracks,
// a title it cannot find, module ids it cannot disambiguate).

/** One lesson file found under a module directory. */
export interface ScaffoldLesson {
  /** Repo-relative path (forward slashes), suitable for course.yaml `lessons[]`. */
  relPath: string;
  title: string;
  /** Where the title came from — 'parsed' reused parseLesson's frontmatter→H1 precedence. */
  titleSource: 'parsed' | 'filename';
  /** Set when titleSource is 'filename', explaining why (missing title, or a real parse problem). */
  note?: string;
}

/** One inferred module: a directory that directly contains at least one markdown lesson file. */
export interface ScaffoldModule {
  id: string;
  title: string;
  lessons: ScaffoldLesson[];
}

/** Something the walk deliberately left out of the draft, and why. */
export interface SkippedEntry {
  /** Repo-relative path. Directories end in `/`. */
  path: string;
  reason: string;
}

export interface ScaffoldOptions {
  /** Overrides the slug otherwise derived from the directory's basename. */
  slug?: string;
  /** Overrides the title otherwise derived from the directory's basename. */
  title?: string;
}

export interface ScaffoldResult {
  manifest: CourseManifest;
  modules: ScaffoldModule[];
  skipped: SkippedEntry[];
  /** The rendered course.yaml text, including the no-tracks comment. */
  yaml: string;
}

// Directories that are never lesson content, regardless of what they contain.
// Anything starting with "." is also always skipped (see isHiddenDir below) —
// that alone covers .git/.github, but node_modules doesn't start with a dot
// so it needs an explicit entry.
const SKIP_DIR_EXACT = new Set(['node_modules']);

// "docs/-style build output": directories that are conventionally *generated*
// by a static-site/docs toolchain rather than authored as lesson content.
// A repo that genuinely keeps lessons in one of these names should rename
// the directory — the skip list is there to keep a first pass honest, not
// to be a permanent rule.
const BUILD_OUTPUT_DIR_NAMES = new Set(['docs', 'site', '_site', 'dist', 'build', 'out', '.next', 'public']);

// Only skipped when they sit directly at the course root (design: "a README
// inside a module directory IS content and must be kept").
const ROOT_SKIP_BASENAMES = new Set(['readme', 'changelog', 'contributing']);

function isHiddenDir(name: string): boolean {
  return name.startsWith('.');
}

/** Extracts a leading run of digits, or null when the name doesn't start with one. */
function leadingNumber(name: string): number | null {
  const match = /^(\d+)/.exec(name);
  return match ? Number(match[1]) : null;
}

/**
 * Orders directory/file entries the way authors expect: numeric prefixes
 * sort numerically (so `10-` comes after `9-`, not before), prefixed entries
 * sort before unprefixed ones, and everything else falls back to
 * alphabetical.
 */
function comparePrefixed(a: string, b: string): number {
  const na = leadingNumber(a);
  const nb = leadingNumber(b);
  if (na !== null && nb !== null && na !== nb) return na - nb;
  if (na !== null && nb === null) return -1;
  if (na === null && nb !== null) return 1;
  return a.localeCompare(b, 'en');
}

/** Strips a leading numeric prefix like `01-` / `2_` / `10.` from a name. */
function stripNumericPrefix(name: string): string {
  return name.replace(/^\d+[-_.]*/, '');
}

/** Lowercase-kebab-cases a string into something that matches the schema's id/slug pattern. */
function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** A directory or file name → a stable, schema-valid id (module id, course slug). */
function deriveId(name: string): string {
  const stripped = stripNumericPrefix(name);
  return slugify(stripped) || slugify(name) || 'module';
}

/**
 * A directory or file name → a human-readable draft title: strip the
 * numeric prefix (and, for files, the extension), replace `-`/`_` with
 * spaces, title-case each word.
 */
function humanize(name: string, isFile: boolean): string {
  const withoutExt = isFile ? name.replace(/\.[^./]+$/, '') : name;
  const withoutPrefix = stripNumericPrefix(withoutExt);
  const words = withoutPrefix
    .replace(/[-_]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const source = words.length > 0 ? words : [withoutExt || name];
  return source.map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : w)).join(' ');
}

function uniqueId(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let n = 2;
  let candidate = `${base}-${n}`;
  while (used.has(candidate)) {
    n++;
    candidate = `${base}-${n}`;
  }
  used.add(candidate);
  return candidate;
}

function relJoin(parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`;
}

/**
 * Infers a lesson's draft title. Reuses parseLesson's own frontmatter→H1
 * precedence so the scaffold's guess matches what the platform will
 * actually show — but a file with neither (or a markdown/frontmatter
 * problem of any kind) must never abort the whole scaffold. This is
 * exactly the case the draft exists for: fall back to a humanised filename
 * and note why, rather than fail.
 */
async function inferLessonTitle(absPath: string, fileName: string): Promise<Omit<ScaffoldLesson, 'relPath'>> {
  let markdown: string;
  try {
    markdown = await readFile(absPath, 'utf8');
  } catch (err) {
    return {
      title: humanize(fileName, true),
      titleSource: 'filename',
      note: `could not read file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    const { title } = parseLesson(markdown);
    return { title, titleSource: 'parsed' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A missing title is the expected, quiet case (no note needed beyond
    // the generic "used filename" the caller already prints). Any other
    // parseLesson failure (bad frontmatter kind/track/estimate, etc.) is a
    // real content problem — still don't abort, but say so.
    const note = /title/i.test(message) ? undefined : `parseLesson could not read this file: ${message}`;
    return { title: humanize(fileName, true), titleSource: 'filename', ...(note !== undefined ? { note } : {}) };
  }
}

/**
 * Walks `courseDir` depth-first, pre-order. A directory becomes a module the
 * moment it directly contains at least one markdown file (its lessons are
 * exactly those direct files, sorted); the walk still descends into its
 * subdirectories afterward, so a directory that mixes direct lesson files
 * with lesson-bearing subdirectories (e.g. `examples/overview.md` plus
 * `examples/projects/*.md`) produces one module per markdown-bearing level,
 * not one flattened module. A directory with no markdown files anywhere in
 * it — direct or nested — never becomes a module (the schema requires
 * `lessons: minItems 1`).
 */
async function walk(courseDir: string): Promise<{ modules: ScaffoldModule[]; skipped: SkippedEntry[] }> {
  const modules: ScaffoldModule[] = [];
  const skipped: SkippedEntry[] = [];
  const usedIds = new Set<string>();

  async function visitDir(absDir: string, relDir: string, depth: number): Promise<void> {
    const entries = await readdir(absDir, { withFileTypes: true });

    const dirNames = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort(comparePrefixed);
    const fileNames = entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
      .map((e) => e.name)
      .sort(comparePrefixed);

    const lessons: ScaffoldLesson[] = [];
    for (const fileName of fileNames) {
      const relPath = relJoin(relDir, fileName);

      if (depth === 0) {
        const baseNoExt = fileName.replace(/\.[^./]+$/, '').toLowerCase();
        if (ROOT_SKIP_BASENAMES.has(baseNoExt)) {
          skipped.push({ path: relPath, reason: 'not lesson content at the repository root (skipped by name)' });
          continue;
        }
      }

      const absPath = path.join(absDir, fileName);
      const inferred = await inferLessonTitle(absPath, fileName);
      lessons.push({ relPath, ...inferred });
    }

    if (depth === 0) {
      // Modules come from directories (design). Loose markdown sitting
      // directly at the course root isn't inside any module directory, so
      // there's nowhere honest to put it in the manifest — report it
      // instead of silently dropping it or inventing a module for it.
      for (const lesson of lessons) {
        skipped.push({
          path: lesson.relPath,
          reason: 'sits at the repository root, not inside a module directory — move it into one to include it',
        });
      }
    } else if (lessons.length > 0) {
      const dirName = path.basename(absDir);
      const id = uniqueId(deriveId(dirName), usedIds);
      modules.push({ id, title: humanize(dirName, false), lessons });
    }

    for (const dirName of dirNames) {
      const relSub = relJoin(relDir, dirName);
      if (isHiddenDir(dirName)) {
        skipped.push({ path: `${relSub}/`, reason: 'hidden directory (skipped by name)' });
        continue;
      }
      if (SKIP_DIR_EXACT.has(dirName)) {
        skipped.push({ path: `${relSub}/`, reason: 'dependency directory (skipped by name)' });
        continue;
      }
      if (BUILD_OUTPUT_DIR_NAMES.has(dirName.toLowerCase())) {
        skipped.push({
          path: `${relSub}/`,
          reason: 'looks like generated docs/build output (skipped by name) — rename it if it is real lesson content',
        });
        continue;
      }
      await visitDir(path.join(absDir, dirName), relSub, depth + 1);
    }
  }

  await visitDir(courseDir, '', 0);
  return { modules, skipped };
}

const TRACKS_COMMENT = [
  "# No tracks were inferred. Tracks are a human judgement call about this course's",
  '# dimensions (design §6.1) — the scaffolder deliberately leaves this to you.',
  '# Add up to 5, each with a unique hue from: blue, teal, ochre, maroon, slate',
  '# tracks:',
  '#   - { id: example, name: Example, hue: blue }',
  '',
].join('\n');

/** Splices the no-tracks comment in just before the `modules:` key. */
function renderYaml(manifest: CourseManifest): string {
  const body = stringifyYaml(manifest, { lineWidth: 0 });
  const idx = body.indexOf('\nmodules:');
  if (idx === -1) return TRACKS_COMMENT + body;
  return body.slice(0, idx + 1) + TRACKS_COMMENT + body.slice(idx + 1);
}

/**
 * Scaffolds a course.yaml draft from a repository tree. Does not touch the
 * filesystem beyond reading it — callers decide whether/where to write the
 * result (see `main` below for the CLI's overwrite-protection).
 */
export async function scaffoldCourse(dir: string, opts: ScaffoldOptions = {}): Promise<ScaffoldResult> {
  const { modules, skipped } = await walk(dir);

  const dirBase = path.basename(dir);
  const slug = opts.slug ?? slugify(dirBase) ?? 'course';
  const title = opts.title ?? humanize(dirBase, false);

  const manifestModules: ModuleDef[] = modules.map((m) => ({
    id: m.id,
    title: m.title,
    lessons: m.lessons.map((l) => l.relPath),
  }));

  const manifest: CourseManifest = {
    schema: 1,
    slug: slug || 'course',
    title,
    modules: manifestModules,
  };

  return { manifest, modules, skipped, yaml: renderYaml(manifest) };
}

function printSummary(dir: string, result: ScaffoldResult): void {
  const lessonCount = result.modules.reduce((n, m) => n + m.lessons.length, 0);
  console.error(`Scaffolded ${result.modules.length} module(s), ${lessonCount} lesson(s) from ${dir}`);
  for (const mod of result.modules) {
    console.error(`  ${mod.id}  (${mod.lessons.length} lesson(s))`);
    for (const lesson of mod.lessons) {
      const flag =
        lesson.titleSource === 'filename' ? `  [${lesson.note ?? 'no title found in file — used filename'}]` : '';
      console.error(`    - ${lesson.relPath}: ${lesson.title}${flag}`);
    }
  }
  if (result.skipped.length > 0) {
    console.error(`Skipped ${result.skipped.length} item(s):`);
    for (const s of result.skipped) {
      console.error(`  ${s.path} — ${s.reason}`);
    }
  }
  console.error('');
  console.error(
    "No tracks were inferred — add up to 5 by hand in the generated YAML, each with a unique hue from: blue, teal, ochre, maroon, slate (design §6.1).",
  );
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const positional: string[] = [];
  let outFile: string | undefined;
  let force = false;
  let slugFlag: string | undefined;
  let titleFlag: string | undefined;

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--out') {
      outFile = rawArgs[++i];
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--slug') {
      slugFlag = rawArgs[++i];
    } else if (arg === '--title') {
      titleFlag = rawArgs[++i];
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }

  const dirArg = positional[0];
  if (!dirArg) {
    console.error('Usage: npm run scaffold -- <dir> [--out <file>] [--force] [--slug <slug>] [--title <title>]');
    process.exitCode = 1;
    return;
  }

  const dir = path.resolve(dirArg);
  if (!existsSync(dir)) {
    console.error(`Directory not found: ${dir}`);
    process.exitCode = 1;
    return;
  }

  if (outFile !== undefined && existsSync(outFile) && !force) {
    console.error(`Refusing to overwrite existing file: ${outFile} (pass --force to overwrite)`);
    process.exitCode = 1;
    return;
  }

  const result = await scaffoldCourse(dir, { slug: slugFlag, title: titleFlag });

  if (result.modules.length === 0) {
    console.error(`No lesson content found under ${dir} — nothing to scaffold.`);
    process.exitCode = 1;
    return;
  }

  printSummary(dir, result);

  if (outFile !== undefined) {
    await writeFile(outFile, result.yaml, 'utf8');
    console.error(`Wrote ${outFile}`);
  } else {
    process.stdout.write(result.yaml);
  }
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
