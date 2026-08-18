/*
 * Badge and degree formatting, kept out of the components so it can be
 * tested without a browser (same split as src/lib/heatmap.ts and
 * src/lib/activity.ts).
 *
 * THE RULE THIS FILE EXISTS TO KEEP: earned and locked are distinguished
 * STRUCTURALLY, never by colour alone (design §14, WCAG 1.4.1). So every
 * state that has a colour also has a WORD — `statusLabel` is rendered as
 * visible text on the card, not just as an aria-label — and the progress
 * figure is a sentence ("3 of 5 lessons"), not only a bar's width.
 */

import type { BadgeProgress, CriterionProgress, DegreeProgress } from './api';

/**
 * "3 of 5 lessons" / "62 of 90 percent" — the counted sentence beside a
 * progress bar.
 *
 * `percent` is the one unit that reads wrong as a bare noun ("62 of 90
 * percents"), so it gets its own phrasing. Numbers are rounded for display
 * only: a track score is a real quotient and would otherwise print sixteen
 * digits.
 */
export function describeProgress(progress: CriterionProgress): string {
  const current = Math.round(progress.current);
  const target = Math.round(progress.target);
  if (progress.unit === 'percent') {
    return `${current}% of the ${target}% needed`;
  }
  return `${current} of ${target} ${progress.unit}`;
}

/** The visible status word for a badge. Never the only difference — see the header. */
export function badgeStatusLabel(badge: BadgeProgress): string {
  return badge.earned ? 'Earned' : 'Locked';
}

/**
 * A one-line reading of a degree's requirements, e.g.
 * "2 of 3 required courses · 1 of 2 electives".
 *
 * Electives are omitted entirely when the degree declares none, rather than
 * printed as "0 of 0" — a degree without electives has not left them
 * unfinished.
 */
export function describeDegreeProgress(degree: DegreeProgress): string {
  const requiredDone = degree.required.filter((r) => r.completed).length;
  const parts = [`${requiredDone} of ${degree.required.length} required courses`];
  if (degree.electives !== null && degree.electives !== undefined) {
    parts.push(`${Math.min(degree.electives.completed, degree.electives.choose)} of ${degree.electives.choose} electives`);
  }
  return parts.join(' · ');
}

/**
 * The sentence an award animation announces to a screen reader.
 *
 * Returns null when nothing was earned, which is the overwhelmingly common
 * case — the caller renders no live region at all rather than an empty one
 * that some readers announce as a change.
 */
export function announceAwards(awards: {
  badges: Array<{ title: string }>;
  degrees: Array<{ title: string }>;
}): string | null {
  const sentences: string[] = [];
  for (const badge of awards.badges) sentences.push(`Badge earned: ${badge.title}.`);
  for (const degree of awards.degrees) sentences.push(`Degree earned: ${degree.title}.`);
  return sentences.length === 0 ? null : sentences.join(' ');
}

/** Absolute award date in the actor's own timezone (design §15), e.g. "Aug 15, 2026". */
export function formatAwardedAt(awardedAt: string | null, timezone: string): string | null {
  if (awardedAt === null) return null;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date(awardedAt));
}
