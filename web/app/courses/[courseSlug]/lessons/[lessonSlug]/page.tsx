import { notFound } from 'next/navigation';
import Link from 'next/link';
import { codeToHtml } from 'shiki';
import type { Lesson } from '../../../../../src/lib/api';
import { fetchLesson } from '../../../../../src/lib/api';
import type { components } from '../../../../../src/lib/api-types';
import MarkCompleteButton from './MarkCompleteButton';
import styles from './lesson.module.css';

type Block = components['schemas']['Block'];
type CodeBlock = Extract<Block, { type: 'code' }>;

// One dual-theme pair covers both colour schemes — see the shiki rules in
// app/globals.css that decide which half paints, driven by
// prefers-color-scheme (no JS theme switcher; that's Phase 4).
const CODE_THEMES = { light: 'github-light', dark: 'github-dark-dimmed' } as const;

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
  params: Promise<{ courseSlug: string; lessonSlug: string }>;
}) {
  const { courseSlug, lessonSlug } = await params;
  const lesson: Lesson | null = await fetchLesson(courseSlug, lessonSlug);

  if (!lesson) {
    notFound();
  }

  const codeIndexes = lesson.blocks
    .map((block, index) => ({ block, index }))
    .filter((entry): entry is { block: CodeBlock; index: number } => entry.block.type === 'code');

  const highlighted = new Map(
    await Promise.all(codeIndexes.map(async ({ block, index }) => [index, await highlightCode(block)] as const)),
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
            ),
          )}
        </div>

        <div className={styles.progress}>
          <MarkCompleteButton
            courseSlug={courseSlug}
            lessonSlug={lesson.slug}
            kind={lesson.kind}
            progress={lesson.progress}
          />
        </div>

        {lesson.prev || lesson.next ? (
          <nav className={styles.nav} aria-label="Lesson navigation">
            {lesson.prev ? (
              <Link
                href={`/courses/${encodeURIComponent(courseSlug)}/lessons/${encodeURIComponent(lesson.prev.slug)}`}
                className={styles.navLink}
              >
                <span className={styles.navLabel}>Previous</span>
                <span className={styles.navTitle}>{lesson.prev.title}</span>
              </Link>
            ) : (
              <span />
            )}
            {lesson.next ? (
              <Link
                href={`/courses/${encodeURIComponent(courseSlug)}/lessons/${encodeURIComponent(lesson.next.slug)}`}
                className={`${styles.navLink} ${styles.navNext}`}
              >
                <span className={styles.navLabel}>Next</span>
                <span className={styles.navTitle}>{lesson.next.title}</span>
              </Link>
            ) : null}
          </nav>
        ) : null}
      </article>
    </main>
  );
}
