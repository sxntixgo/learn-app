/*
 * Home's resume banner — the top of M1 and the top of P2.
 *
 * ONE COMPONENT, TWO TIERS. The artboards draw it twice: wide (M1) it is a
 * single teal row — big percent, lesson identity, two statistics, a Resume
 * pill; narrow (P2) it is a teal hero with the percent and a sentence, and
 * the statistics fall out of it into a row of tiles below. That is the same
 * elements in a different flow, so it is one tree and a grid change in
 * me.module.css rather than two components and a `display: none`, which
 * would put every number in the DOM twice.
 *
 * `current` is null only when nothing is resumable — no enrolment, or every
 * lesson of every course finished. The banner still renders: the streak and
 * the week are true regardless, and an empty space where the top of the
 * page should be reads as a broken screen rather than as an empty one.
 *
 * Purely presentational, so it stays a server component.
 */

import Link from 'next/link';
import type { CoursePlan } from '../../src/lib/home';
import styles from './me.module.css';

export interface HomeStat {
  label: string;
  value: string;
  /** Longer form for a screen reader — the label alone is a two-word abbreviation. */
  description: string;
}

export interface ResumeBannerProps {
  /** The course to resume, with a next lesson, or null when there is nothing to resume. */
  current: CoursePlan | null;
  /** Percent complete — the resumable course's, or everything's when there is none. */
  percent: number;
  stats: readonly HomeStat[];
}

export default function ResumeBanner({ current, percent, stats }: ResumeBannerProps) {
  // pickCurrentCourse only ever returns a plan that HAS a next lesson, so
  // these two are set together or not at all.
  const next = current?.next ?? null;

  return (
    <section className={styles.resume} aria-labelledby="resume-heading">
      <h2 className={styles.srOnly} id="resume-heading">
        Where you left off
      </h2>

      <p className={styles.resumePercent}>
        {percent}
        <span className={styles.resumePercentSign}>%</span>
      </p>

      <div className={styles.resumeIdentity}>
        {current && next ? (
          <>
            {/* Plain numbers here: M1 writes "MODULE 2 · LESSON 6 · 7 MIN". The
                zero-padded form is for the numbered ROWS (Up next, Your courses). */}
            <p className={styles.resumeEyebrow}>
              Module {next.moduleNumber} · Lesson {next.number}
              {next.lesson.estimateMinutes ? ` · ${next.lesson.estimateMinutes} min` : ''}
            </p>
            <p className={styles.resumeLesson}>{next.lesson.title}</p>
            <p className={styles.resumeCourse}>{current.title}</p>
          </>
        ) : (
          <>
            <p className={styles.resumeEyebrow}>Nothing in progress</p>
            <p className={styles.resumeLesson}>Pick something to learn</p>
            <p className={styles.resumeCourse}>Every course says what it covers before you join</p>
          </>
        )}
      </div>

      <ul className={styles.resumeStats}>
        {stats.map((stat) => (
          <li className={styles.stat} key={stat.label}>
            <span className={styles.statValue}>{stat.value}</span>
            <span className={styles.statLabel}>
              {stat.label}
              <span className={styles.srOnly}> — {stat.description}</span>
            </span>
          </li>
        ))}
      </ul>

      {current && next ? (
        <Link className={styles.resumeAction} href={next.href}>
          Resume <span aria-hidden="true">→</span>
        </Link>
      ) : (
        <Link className={styles.resumeAction} href="/">
          Find a course <span aria-hidden="true">→</span>
        </Link>
      )}
    </section>
  );
}
