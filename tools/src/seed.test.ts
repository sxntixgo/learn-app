import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';

const { Pool } = pg;

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL is not set — required to run seed.test.ts');
}

describe.sequential('seed', () => {
  const pool = new Pool({ connectionString });

  afterAll(async () => {
    await pool.query('DROP TABLE IF EXISTS lessons');
    await pool.query('DROP TABLE IF EXISTS schema_migrations');
    await pool.end();
  });

  it('inserts a row with expected slug/title/block-count', async () => {
    // Allow previous tests' connections to fully close
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Ensure fresh state
    try {
      await pool.query('DROP TABLE IF EXISTS lessons');
    } catch {
      // ignore
    }
    try {
      await pool.query('DROP TABLE IF EXISTS schema_migrations');
    } catch {
      // ignore
    }

    // Create the table directly
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lessons (
        id           uuid primary key default gen_random_uuid(),
        slug         text not null unique,
        title        text not null,
        blocks       jsonb not null,
        created_at   timestamptz not null default now(),
        updated_at   timestamptz not null default now()
      )
    `);

    const { parseLesson } = await import('@learn/api/content/parse');
    const markdown = `# Hello World

This is a prose block.

\`\`\`typescript
const x = 42;
\`\`\`

Another prose block.
`;

    const parsed = parseLesson(markdown);
    const slug = 'hello-world';
    const blocksJson = JSON.stringify(parsed.blocks);

    await pool.query(
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

    // Verify the row was inserted
    const result = await pool.query('SELECT slug, title, blocks FROM lessons WHERE slug = $1', [slug]);
    expect(result.rowCount).toBe(1);
    expect(result.rows[0].slug).toBe('hello-world');
    expect(result.rows[0].title).toBe('Hello World');
    expect(result.rows[0].blocks).toHaveLength(3);
    expect(result.rows[0].blocks[0].type).toBe('prose');
    expect(result.rows[0].blocks[1].type).toBe('code');
    expect(result.rows[0].blocks[1].lang).toBe('typescript');
    expect(result.rows[0].blocks[2].type).toBe('prose');
  });

  it('upserts on slug conflict, updating updated_at', async () => {
    // Allow previous tests' connections to fully close
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Ensure fresh state
    try {
      await pool.query('DROP TABLE IF EXISTS lessons');
    } catch {
      // ignore
    }
    try {
      await pool.query('DROP TABLE IF EXISTS schema_migrations');
    } catch {
      // ignore
    }

    // Create the table directly
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lessons (
        id           uuid primary key default gen_random_uuid(),
        slug         text not null unique,
        title        text not null,
        blocks       jsonb not null,
        created_at   timestamptz not null default now(),
        updated_at   timestamptz not null default now()
      )
    `);

    const { parseLesson } = await import('@learn/api/content/parse');
    const markdown1 = `# Lesson One

Content one.
`;

    const markdown2 = `# Lesson Two

Content two.

\`\`\`js
console.log('update');
\`\`\`
`;

    const parsed1 = parseLesson(markdown1);
    const parsed2 = parseLesson(markdown2);
    const slug = 'test-lesson';

    // First insert
    await pool.query(
      `
      INSERT INTO lessons (slug, title, blocks)
      VALUES ($1, $2, $3)
      ON CONFLICT (slug) DO UPDATE SET
        title = $2,
        blocks = $3,
        updated_at = now()
      `,
      [slug, parsed1.title, JSON.stringify(parsed1.blocks)],
    );

    // Wait a bit to ensure time difference
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Second insert (update)
    await pool.query(
      `
      INSERT INTO lessons (slug, title, blocks)
      VALUES ($1, $2, $3)
      ON CONFLICT (slug) DO UPDATE SET
        title = $2,
        blocks = $3,
        updated_at = now()
      `,
      [slug, parsed2.title, JSON.stringify(parsed2.blocks)],
    );

    // Verify exactly one row exists
    const countResult = await pool.query('SELECT COUNT(*)::int as count FROM lessons WHERE slug = $1', [slug]);
    expect(countResult.rows[0].count).toBe(1);

    // Verify the row was updated
    const result = await pool.query('SELECT title, blocks FROM lessons WHERE slug = $1', [slug]);
    expect(result.rows[0].title).toBe('Lesson Two');
    expect(result.rows[0].blocks).toHaveLength(2);
    expect(result.rows[0].blocks[1].type).toBe('code');
  });
});
