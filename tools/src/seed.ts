import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { parseLesson } from '@learn/api/content/parse';

const { Pool } = pg;

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
      const blocksJson = JSON.stringify(parsed.blocks);
      await client.query(
        `
        INSERT INTO lessons (slug, title, blocks)
        VALUES ($1, $2, $3)
        ON CONFLICT (slug) DO UPDATE SET
          title = $2,
          blocks = $3,
          updated_at = now()
        `,
        [slug, parsed.title, blocksJson],
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
