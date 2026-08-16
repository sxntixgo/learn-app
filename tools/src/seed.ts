import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { parseLesson } from '@learn/api/content/parse';

const { Pool } = pg;

// Phase 2's content schema (db/migrations/0002_content_schema.sql) makes
// lessons.course_id/module_id NOT NULL, upserted on (module_id, lesson_key)
// — there is no real manifest-driven course here, so seed.ts creates/reuses
// one disposable "scratch" course + module to hang ad hoc dev/test lessons
// off of, rather than the real importer's per-repo courses.
const SCRATCH_COURSE_SLUG = 'scratch';
const SCRATCH_MODULE_KEY = 'scratch';

async function ensureScratchCourseAndModule(client: pg.PoolClient): Promise<{ courseId: string; moduleId: string }> {
  const course = await client.query<{ id: string }>(
    `
    INSERT INTO courses (slug, title)
    VALUES ($1, $2)
    ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
    RETURNING id
    `,
    [SCRATCH_COURSE_SLUG, 'Scratch'],
  );
  const courseId = course.rows[0]!.id;

  const module = await client.query<{ id: string }>(
    `
    INSERT INTO modules (course_id, key, title)
    VALUES ($1, $2, $3)
    ON CONFLICT (course_id, key) DO UPDATE SET key = EXCLUDED.key
    RETURNING id
    `,
    [courseId, SCRATCH_MODULE_KEY, 'Scratch'],
  );
  const moduleId = module.rows[0]!.id;

  return { courseId, moduleId };
}

/**
 * Derives a slug from a filename.
 * - Lowercase
 * - Strip extension
 * - Replace non-alphanumerics with `-`
 * - Collapse repeated `-`
 * - Trim leading/trailing `-`
 */
function deriveSlugFromFilename(filename: string): string {
  const withoutExt = filename.replace(/\.[^.]*$/, '');
  const normalized = withoutExt.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return normalized.replace(/^-+|-+$/g, '');
}

async function main(): Promise<void> {
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }

  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: npm run seed -- <path-to-markdown> [--slug my-slug]');
    process.exitCode = 1;
    return;
  }

  const filePath = args[0]!;
  let slug: string | undefined;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--slug' && i + 1 < args.length) {
      slug = args[i + 1];
      i++;
    }
  }

  if (!existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exitCode = 1;
    return;
  }

  let markdown: string;
  try {
    markdown = await readFile(filePath, 'utf8');
  } catch (err) {
    console.error(`Failed to read file: ${filePath}`, err);
    process.exitCode = 1;
    return;
  }

  let parsed;
  try {
    parsed = parseLesson(markdown);
  } catch (err) {
    console.error(`Failed to parse lesson: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  if (!slug) {
    const filename = path.basename(filePath);
    slug = deriveSlugFromFilename(filename);
  }

  slug = slug || 'untitled';

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set');
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({ connectionString });
  try {
    const client = await pool.connect();
    try {
      const { courseId, moduleId } = await ensureScratchCourseAndModule(client);
      const blocksJson = JSON.stringify(parsed.blocks);
      const contentHash = createHash('sha256').update(markdown).digest('hex');

      await client.query(
        `
        INSERT INTO lessons (course_id, module_id, lesson_key, slug, title, source_path, content_hash, blocks)
        VALUES ($1, $2, $3, $3, $4, $5, $6, $7)
        ON CONFLICT (module_id, lesson_key) DO UPDATE SET
          slug = EXCLUDED.slug,
          title = EXCLUDED.title,
          source_path = EXCLUDED.source_path,
          content_hash = EXCLUDED.content_hash,
          blocks = EXCLUDED.blocks,
          updated_at = now()
        `,
        [courseId, moduleId, slug, parsed.title, filePath, contentHash, blocksJson],
      );
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(`Failed to insert/update lesson: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  } finally {
    await pool.end();
  }

  console.log(`${slug} | ${parsed.title} | ${parsed.blocks.length} block(s)`);
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
