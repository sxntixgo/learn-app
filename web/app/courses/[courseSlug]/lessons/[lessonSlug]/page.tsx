import { notFound } from 'next/navigation';
import Link from 'next/link';
import type { CourseDetail, CourseProgressSummary, Lesson, Submission } from '../../../../../src/lib/api';
import { fetchCourse, fetchCourseProgress, fetchLesson, fetchMe, fetchSubmission } from '../../../../../src/lib/api';
import { withAuthRedirect } from '../../../../../src/lib/require-auth';
import type { components } from '../../../../../src/lib/api-types';
import type { AuthorAnnotationInput } from '../../../../../src/lib/annotations';
import { highlightCodeBlocks } from '../../../../../src/lib/highlight';
import { checkpointEyebrow } from '../../../../../src/lib/quiz';
import AnnotatableCode from './AnnotatableCode';
import Chart from './Chart';
import { Contents, ContentsProvider, ContentsToggle, type ContentsModule } from './Contents';
import ExercisePanel from './ExercisePanel';
import Diagram from './Diagram';
import Figure from './Figure';
import MarkCompleteButton from './MarkCompleteButton';
import Quiz from './Quiz';
import styles from './lesson.module.css';

type Block = components['schemas']['Block'];
type CodeBlock = Extract<Block, { type: 'code' }>;
type QuizBlock = Extract<Block, { type: 'quiz' }>;

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

  // The reader's course contents (artboard-spec §4, PL4/PL5/P5/P6) — the
  // same course.tracks-adjacent data /courses/[courseSlug] already reads,
  // fetched again here rather than threaded through props because this is
  // a separate route/request. Degrades to absent (no panel, no mobile
  // header) if the course fetch comes back null, same as the rail's
  // ENROLLED list degrades in Shell.tsx — a reader can always still read.
  const [course, courseProgress]: [CourseDetail | null, CourseProgressSummary | null] = await withAuthRedirect(
    `/courses/${courseSlug}/lessons/${lessonSlug}`,
    () => Promise.all([fetchCourse(courseSlug), fetchCourseProgress(courseSlug)]),
  );

  const contentsModules: ContentsModule[] =
    course?.modules.map((mod) => ({
      key: mod.key,
      position: mod.position,
      title: mod.title,
      lessons: mod.lessons.map((l) => ({ slug: l.slug, title: l.title, kind: l.kind })),
    })) ?? [];

  const lessonStates = new Map((courseProgress?.lessons ?? []).map((l) => [l.slug, l.state]));

  // Flattened in manifest order so the current lesson's overall position
  // ("6/12", P5's header) and its module ("MODULE 2", the back link) can
  // be read off one pass, the same order CourseDetail.modules is already
  // in (design says nothing stronger than "manifest order" for either).
  const flatLessons = contentsModules.flatMap((mod) => mod.lessons.map((l) => ({ ...l, module: mod })));
  const currentPosition = flatLessons.findIndex((l) => l.slug === lesson.slug);
  const currentModule = currentPosition >= 0 ? flatLessons[currentPosition]!.module : null;
  const totalLessons = flatLessons.length;

  // artboard-spec §7 Q2: Checkpoint IS a quiz-kind lesson at this same
  // route — "CHECKPOINT · N QUESTIONS · PASS AT N" (PL6/P7) replaces the
  // generic "Lesson N · M min" eyebrow the reader task built, which only
  // ever covered kind "lesson"/"exercise".
  const quizBlock = lesson.kind === 'quiz' ? blocks.find((b): b is QuizBlock => b.type === 'quiz') : undefined;

  const eyebrow = quizBlock
    ? checkpointEyebrow(quizBlock.questions.length, quizBlock.pass)
    : currentModule && lesson.estimateMinutes !== null
      ? `Lesson ${currentPosition + 1} · ${lesson.estimateMinutes} min`
      : currentModule
        ? `Lesson ${currentPosition + 1}`
        : null;

  // PL6/P7's own back link — to the PREVIOUS LESSON, not the module — takes
  // the place of the contents toggle a non-quiz lesson shows here (below).
  // Reused as Quiz.tsx's graded-not-passed "LESSON" link too, so both point
  // at the same place.
  const previousLessonHref = lesson.prev
    ? `/courses/${encodeURIComponent(courseSlug)}/lessons/${encodeURIComponent(lesson.prev.slug)}`
    : undefined;

  // artboard-spec §7 Q2: PL6/P7 show NO contents panel and no mobile header
  // — a focused lesson, not a destination with its own navigation chrome.
  // The reader task's Contents panel/mobile header render unconditionally
  // whenever `course` resolves, regardless of kind; both are suppressed
  // here for quiz-kind lessons only, so a "lesson"/"exercise" lesson is
  // unaffected (nav-labels.test.ts's sibling, quiz.test.ts, and
  // e2e/specs/viewport.spec.ts's existing reader assertions cover that kind
  // already).
  const isCheckpoint = lesson.kind === 'quiz';
  // Once a checkpoint is actually passed, `lesson.progress.state` flips to
  // "complete" server-side (Quiz.tsx's `router.refresh()` re-fetches this
  // page) — at that point MarkCompleteButton's "Completed" state and the
  // Previous/Next footer reappear, so a checkpoint at the end of a course
  // still has a way forward. Neither cached artboard shows a passed
  // checkpoint, so this is the conservative default, not a copied artboard.
  const checkpointUngraded = isCheckpoint && lesson.progress?.state !== 'complete';

  return (
    <ContentsProvider>
      <div className={styles.layout}>
        {course && !isCheckpoint ? (
          <Contents
            courseSlug={courseSlug}
            courseTitle={course.title}
            modules={contentsModules}
            lessonStates={lessonStates}
            currentLessonSlug={lesson.slug}
          />
        ) : null}
        <div className={styles.page}>
          {course && currentModule && !isCheckpoint ? (
            <div className={styles.mobileHeader}>
              <div className={styles.mobileHeaderRow}>
                <Link href={`/courses/${courseSlug}`} className={styles.mobileBack}>
                  ← Module {currentModule.position}
                </Link>
                <span className={styles.mobileSpacer} />
                <ContentsToggle variant="narrow" />
                <span className={styles.mobileCount}>
                  {currentPosition + 1}/{totalLessons}
                </span>
              </div>
              <div className={styles.mobileProgress} role="img" aria-label={`Lesson ${currentPosition + 1} of ${totalLessons}`}>
                <div
                  className={styles.mobileProgressFill}
                  style={{ width: `${totalLessons > 0 ? Math.round(((currentPosition + 1) / totalLessons) * 100) : 0}%` }}
                />
              </div>
            </div>
          ) : null}
          <article>
            {isCheckpoint ? (
              // PL6/P7's "← THE BASE CASE" — the previous LESSON, not the
              // module — in place of the contents toggle a non-quiz lesson
              // shows here, since there is no panel to toggle.
              previousLessonHref ? (
                <Link href={previousLessonHref} className={styles.checkpointBack}>
                  ← {lesson.prev!.title}
                </Link>
              ) : null
            ) : course ? (
              <ContentsToggle variant="wide" />
            ) : null}
            {eyebrow ? <p className={styles.eyebrow}>{eyebrow}</p> : null}
            <h1 className={styles.title}>{lesson.title}</h1>
            <div className={styles.titleRule} />
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
                    return (
                      <div key={index} className={styles.prose} dangerouslySetInnerHTML={{ __html: block.html }} />
                    );
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
                        previousLessonHref={previousLessonHref}
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

            {/*
             * PL6/P7 show nothing below CHECK ANSWERS / RETRY-LESSON — no
             * "completion comes from passing the quiz" note (Quiz.tsx's own
             * banner already says whether this attempt passed) and no
             * Previous/Next footer, since the back link above and Quiz's own
             * LESSON button already cover "go back". Both reappear once the
             * checkpoint is actually passed (`checkpointUngraded` above).
             */}
            {checkpointUngraded ? null : (
              <div className={styles.progress}>
                <MarkCompleteButton
                  courseSlug={courseSlug}
                  lessonSlug={lesson.slug}
                  kind={lesson.kind}
                  progress={lesson.progress}
                />
              </div>
            )}

            {!checkpointUngraded && (lesson.prev || lesson.next) ? (
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
        </div>
      </div>
    </ContentsProvider>
  );
}
