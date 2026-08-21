import { notFound } from 'next/navigation';
import Link from 'next/link';
import type { Lesson, Submission } from '../../../../../src/lib/api';
import { fetchLesson, fetchMe, fetchSubmission } from '../../../../../src/lib/api';
import { withAuthRedirect } from '../../../../../src/lib/require-auth';
import type { components } from '../../../../../src/lib/api-types';
import type { AuthorAnnotationInput } from '../../../../../src/lib/annotations';
import { highlightCodeBlocks } from '../../../../../src/lib/highlight';
import AnnotatableCode from './AnnotatableCode';
import Chart from './Chart';
import ExercisePanel from './ExercisePanel';
import Diagram from './Diagram';
import Figure from './Figure';
import MarkCompleteButton from './MarkCompleteButton';
import Quiz from './Quiz';
import styles from './lesson.module.css';

type Block = components['schemas']['Block'];
type CodeBlock = Extract<Block, { type: 'code' }>;

/*
 * Author annotations (design §6.3's `[!note]` markers) are parsed at import
 * and stored on the code block, and the lesson route passes stored blocks
 * through untouched — so they arrive here even though openapi.yaml's
 * CodeBlock does not describe them yet. Declaring the field locally keeps
 * the reader honest about what it actually receives; adding it to the
 * contract belongs with the exercise endpoints, not here.
 */
type AnnotatedCodeBlock = CodeBlock & { annotations?: AuthorAnnotationInput[] };

const isCodeBlock = (block: Block): block is CodeBlock => block.type === 'code';

export default async function LessonPage({
  params,
}: {
  params: Promise<{ courseSlug: string; lessonSlug: string }>;
}) {
  const { courseSlug, lessonSlug } = await params;
  const lesson: Lesson | null = await withAuthRedirect(`/courses/${courseSlug}/lessons/${lessonSlug}`, () =>
    fetchLesson(courseSlug, lessonSlug),
  );

  if (!lesson) {
    notFound();
  }

  // Design §9.4: "submissions snapshot the block content as presented ...
  // never the live lesson." The moment a submission exists — draft,
  // submitted, or returned — its snapshot is what gets rendered, not
  // `lesson.blocks`, so an edit to the lesson afterward can never change
  // what this page shows for a submission that already anchors annotations
  // to the version that existed when it was taken. Only a student who has
  // never started this exercise sees the live lesson at all.
  const submission: Submission | null =
    lesson.kind === 'exercise'
      ? await withAuthRedirect(`/courses/${courseSlug}/lessons/${lessonSlug}`, () =>
          fetchSubmission(courseSlug, lesson.slug),
        )
      : null;
  const blocks: Block[] = submission ? submission.snapshot : lesson.blocks;

  const highlighted = await highlightCodeBlocks(blocks, isCodeBlock);

  // Only exercises need this — it is how ExercisePanel tells the student's
  // OWN annotations apart from a teacher's replies/flags once a submission
  // is returned (design §9.4; see fromGradedAnnotations).
  const me = lesson.kind === 'exercise' ? await fetchMe() : null;

  return (
    <main className={styles.page}>
      <article>
        <h1 className={styles.title}>{lesson.title}</h1>
        {lesson.kind === 'exercise' ? (
          <ExercisePanel
            courseSlug={courseSlug}
            lessonSlug={lesson.slug}
            blocks={blocks}
            highlighted={highlighted}
            initialSubmission={submission}
            progress={lesson.progress}
            studentUserId={me!.id}
          />
        ) : (
          <div className={styles.body}>
            {blocks.map((block, index) => {
              if (block.type === 'prose') {
                // The API hands us HTML it parsed from our own markdown source.
                // Sanitizing untrusted/rendered HTML before it reaches the DOM
                // is Phase 5's job — not built here.
                return <div key={index} className={styles.prose} dangerouslySetInnerHTML={{ __html: block.html }} />;
              }
              if (block.type === 'code') {
                // Design §9.4: the same block, two modes. A lesson (kind
                // "lesson") shows the author's annotations read-only; an
                // exercise's own code blocks render through ExercisePanel
                // above instead, so this branch only ever runs in "read"
                // mode here.
                return (
                  <div key={index} className={styles.code}>
                    <AnnotatableCode
                      html={highlighted[index] ?? ''}
                      lang={block.lang ?? undefined}
                      mode="read"
                      authorAnnotations={(block as AnnotatedCodeBlock).annotations}
                    />
                  </div>
                );
              }
              if (block.type === 'quiz') {
                // Design §9.1: not markable — the Quiz component owns scoring
                // and completion for this lesson entirely through the
                // .../quiz endpoint, never through MarkCompleteButton.
                return (
                  <Quiz
                    key={index}
                    courseSlug={courseSlug}
                    lessonSlug={lesson.slug}
                    quiz={block}
                    progress={lesson.progress}
                  />
                );
              }
              if (block.type === 'chart') {
                return <Chart key={index} kind={block.kind} caption={block.caption} data={block.data} />;
              }
              if (block.type === 'diagram') {
                return <Diagram key={index} source={block.source} caption={block.caption} />;
              }
              if (block.type === 'figure') {
                return <Figure key={index} svg={block.svg} caption={block.caption} />;
              }
              // block.type === 'rubric'. Rubric blocks are declared beside
              // an EXERCISE (design §9.4) and this branch only ever renders
              // a lesson/quiz-kind lesson's blocks — ExercisePanel is what
              // handles kind "exercise" above — so there is nothing to grade
              // here. Rendered as nothing rather than crashed on, in case a
              // future content shape ever puts one here.
              return null;
            })}
          </div>
        )}

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
