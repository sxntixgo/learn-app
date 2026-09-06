'use client';

/*
 * The reader's course contents — the delta between PL4 ("contents open")
 * and PL5 ("contents collapsed") at the wide tier, and between P5 (reader)
 * and P6 ("contents sheet") at the narrow tier (artboard-spec §4). One
 * boolean, one piece of markup, two shapes chosen by contents.module.css —
 * same reasoning as app/_shell/NavDrawer.tsx's one `<nav>` for the rail and
 * the drawer: a CSS-hidden per-tier copy would put two of every lesson link
 * in the DOM, a duplicate-landmark problem for a reader and a strict-mode
 * problem for any spec that locates one by role.
 *
 *   at/above 1024px  an in-flow column to the left of the reading column,
 *                     collapsible (PL4 open / PL5 collapsed — the panel is
 *                     simply absent from the layout when collapsed, not
 *                     width:0, so `.page` reclaims the space);
 *   below 1024px      a bottom sheet over the page (P6), opened by a pill
 *                     in the narrow header (P5's "CONTENTS" pill).
 *
 * `ContentsProvider` is the shared boolean (mirrors NavDrawerProvider);
 * `ContentsToggle` renders ONE control per call site (a `wide` pill inside
 * the reading column, per PL4/PL5, and a `narrow` pill in the mobile
 * header, per P5/P6) — both drive the same state, so opening one and
 * looking at the other never disagrees. `Contents` is the panel/sheet
 * itself: the course's modules and lessons, with the same done/current/todo
 * dot the reader artboards draw (`{{ l.dotBg }}` / `{{ l.dotBorder }}` in
 * the cached artboard HTML).
 */

import Link from 'next/link';
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from 'react';
import styles from './contents.module.css';

export type ContentsLessonKind = 'lesson' | 'exercise' | 'quiz';
export type ContentsLessonState = 'not_started' | 'in_progress' | 'complete';

export interface ContentsModule {
  key: string;
  position: number;
  title: string;
  lessons: Array<{ slug: string; title: string; kind: ContentsLessonKind }>;
}

interface ContentsState {
  open: boolean;
  toggle(): void;
  close(): void;
}

const ContentsContext = createContext<ContentsState | null>(null);

export function ContentsProvider({ children }: { children: ReactNode }) {
  // SSR/first-paint default: closed. Safe for the narrow tier (P5 does not
  // show the sheet on load) and corrected up to "open" for the wide tier
  // (PL4's default) by the layout effect below, which runs before the
  // browser paints — so there is nothing to see flash on a wide viewport.
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    if (window.matchMedia('(min-width: 1024px)').matches) setOpen(true);
  }, []);

  // Escape closes the narrow-tier sheet, same affordance as the nav
  // drawer's (Nav.tsx). Scoped to narrow: at the wide tier the panel is a
  // permanent column, not a dismissible overlay, so Escape has nothing to
  // dismiss there.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !window.matchMedia('(min-width: 1024px)').matches) {
        setOpen(false);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  return (
    <ContentsContext.Provider
      value={{ open, toggle: () => setOpen((o) => !o), close: () => setOpen(false) }}
    >
      {children}
    </ContentsContext.Provider>
  );
}

function useContentsState(): ContentsState {
  const state = useContext(ContentsContext);
  if (!state) throw new Error('useContentsState must be used inside <ContentsProvider>');
  return state;
}

/** The `<nav>` both toggles point at — one id, so `aria-controls` never disagrees. */
export const CONTENTS_PANEL_ID = 'lesson-contents';

/**
 * One control per call site (LessonPage renders both): `wide` is the
 * "‹ HIDE CONTENTS" / "CONTENTS ›" pill above the eyebrow (PL4/PL5),
 * `narrow` is the plain "CONTENTS" pill in the mobile header (P5/P6).
 * contents.module.css hides whichever does not belong at the current tier,
 * the same technique app/_shell/NavDrawer.tsx's hamburger uses.
 */
export function ContentsToggle({ variant }: { variant: 'wide' | 'narrow' }) {
  const { open, toggle } = useContentsState();
  const className = variant === 'wide' ? styles.toggleWide : styles.toggleNarrow;
  const label = variant === 'wide' ? (open ? '‹  Hide contents' : 'Contents  ›') : 'Contents';

  return (
    <button
      type="button"
      className={className}
      aria-expanded={open}
      aria-controls={CONTENTS_PANEL_ID}
      onClick={toggle}
    >
      {label}
    </button>
  );
}

/**
 * The panel/sheet content — a course's modules, each lesson a link with a
 * done/current/todo dot (PL4's `syllabus` data: gold = done, teal =
 * current, transparent-bordered = todo). Rendered once; contents.module.css
 * repositions the same markup per tier rather than the page choosing which
 * copy to render.
 */
export function Contents({
  courseSlug,
  courseTitle,
  modules,
  lessonStates,
  currentLessonSlug,
}: {
  courseSlug: string;
  courseTitle: string;
  modules: readonly ContentsModule[];
  lessonStates: ReadonlyMap<string, ContentsLessonState>;
  currentLessonSlug: string;
}) {
  const { open, close } = useContentsState();

  return (
    <>
      {open ? (
        <button type="button" className={styles.backdrop} aria-label="Close contents" onClick={close} />
      ) : null}
      <nav
        id={CONTENTS_PANEL_ID}
        aria-label="Course contents"
        className={styles.panel}
        data-open={open ? 'true' : 'false'}
      >
        <div className={styles.panelHeader}>
          <span className={styles.panelTitle}>Contents</span>
          <span className={styles.panelCourse}>{courseTitle}</span>
        </div>
        <div className={styles.panelBody}>
          {modules.map((mod) => (
            <div key={mod.key} className={styles.module}>
              <p className={styles.moduleTag}>MODULE {mod.position}</p>
              <ul className={styles.lessonList}>
                {mod.lessons.map((lesson) => {
                  const current = lesson.slug === currentLessonSlug;
                  const state = lessonStates.get(lesson.slug) ?? 'not_started';
                  const dotState = current ? 'current' : state === 'complete' ? 'done' : 'todo';
                  return (
                    <li key={lesson.slug}>
                      <Link
                        href={`/courses/${encodeURIComponent(courseSlug)}/lessons/${encodeURIComponent(lesson.slug)}`}
                        className={styles.lessonRow}
                        aria-current={current ? 'page' : undefined}
                      >
                        <span className={styles.dot} data-state={dotState} aria-hidden="true" />
                        <span className={styles.lessonTitle} data-state={dotState}>
                          {lesson.title}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </nav>
    </>
  );
}
