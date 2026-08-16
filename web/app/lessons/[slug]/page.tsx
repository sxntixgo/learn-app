import { notFound } from 'next/navigation';
import { codeToHtml } from 'shiki';
import type { components } from '../../../src/lib/api-types';
import styles from './lesson.module.css';

type Lesson = components['schemas']['Lesson'];
type Block = components['schemas']['Block'];
type CodeBlock = Extract<Block, { type: 'code' }>;

// One dual-theme pair covers both colour schemes — see the shiki rules in
// app/globals.css that decide which half paints, driven by
// prefers-color-scheme (no JS theme switcher; that's Phase 4).
const CODE_THEMES = { light: 'github-light', dark: 'github-dark-dimmed' } as const;

async function fetchLesson(slug: string): Promise<Lesson | null> {
  const base = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!base) {
    throw new Error('NEXT_PUBLIC_API_BASE_URL is not set');
  }

  const res = await fetch(`${base}/api/v1/lessons/${encodeURIComponent(slug)}`, {
    cache: 'no-store',
  });

  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`Failed to fetch lesson "${slug}": ${res.status}`);
  }

  return (await res.json()) as Lesson;
}

// Highlighting happens here, at render time, never at import/build time
// (CLAUDE.md rule 4). A language shiki doesn't recognise falls back to
// plain text rather than failing the whole page.
async function highlightCode(block: CodeBlock): Promise<string> {
  const lang = block.lang ?? 'text';
  try {
    return await codeToHtml(block.source, { lang, themes: CODE_THEMES, defaultColor: false });
  } catch {
    return await codeToHtml(block.source, { lang: 'text', themes: CODE_THEMES, defaultColor: false });
  }
}

export default async function LessonPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const lesson = await fetchLesson(slug);

  if (!lesson) {
    notFound();
  }

  const codeIndexes = lesson.blocks
    .map((block, index) => ({ block, index }))
    .filter((entry): entry is { block: CodeBlock; index: number } => entry.block.type === 'code');

  const highlighted = new Map(
    await Promise.all(
      codeIndexes.map(async ({ block, index }) => [index, await highlightCode(block)] as const)
    )
  );

  return (
    <main className={styles.page}>
      <article>
        <h1 className={styles.title}>{lesson.title}</h1>
        <div className={styles.body}>
          {lesson.blocks.map((block, index) =>
            block.type === 'prose' ? (
              // The API hands us HTML it parsed from our own markdown source.
              // Sanitizing untrusted/rendered HTML before it reaches the DOM
              // is Phase 5's job — not built here.
              <div key={index} className={styles.prose} dangerouslySetInnerHTML={{ __html: block.html }} />
            ) : (
              <div
                key={index}
                className={styles.code}
                dangerouslySetInnerHTML={{ __html: highlighted.get(index) ?? '' }}
              />
            )
          )}
        </div>
      </article>
    </main>
  );
}
