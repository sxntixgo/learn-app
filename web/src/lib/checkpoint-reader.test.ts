import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/**
 * PL6/P7 (artboard-spec §7 Q2 — "Checkpoint is a quiz-kind lesson at the
 * existing route") show NO contents panel and NO mobile header, unlike
 * every other lesson kind. The lesson route's `Contents`/mobile-header
 * blocks render unconditionally whenever `course` resolves, regardless of
 * kind — this test reads the route's own source (the same technique
 * `nav-labels.test.ts` uses for JSX this suite has no render harness for:
 * `vitest.config.ts` runs the `web` project under `environment: 'node'`,
 * with no jsdom/testing-library, so mounting the page component isn't an
 * option) and pins two things:
 *
 *   1. the suppression is real — each of the three render sites the reader
 *      task built (the `Contents` panel, the mobile header, and the wide
 *      `ContentsToggle`) is gated on kind, not just on `course`;
 *   2. the suppression is SCOPED to quiz-kind lessons — the same gating
 *      expression appears at both sites, so a "lesson"/"exercise" lesson
 *      falls through to the unconditional `course`-only render the reader
 *      task shipped, unchanged.
 */
const pageSource = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../app/courses/[courseSlug]/lessons/[lessonSlug]/page.tsx',
  ),
  'utf8',
);

describe('checkpoint (quiz-kind lesson) reader chrome', () => {
  it('derives isCheckpoint from lesson.kind, not from an unrelated flag', () => {
    expect(pageSource).toMatch(/const isCheckpoint = lesson\.kind === 'quiz'/);
  });

  it('gates the Contents panel on !isCheckpoint, alongside the existing course check', () => {
    // "course && !isCheckpoint" (or the same two clauses in either order) —
    // a non-quiz lesson with a resolved `course` still renders it.
    expect(pageSource).toMatch(/\{course && !isCheckpoint \?\s*\(\s*<Contents/);
  });

  it('gates the mobile header on !isCheckpoint too', () => {
    expect(pageSource).toMatch(/\{course && currentModule && !isCheckpoint \?\s*\(\s*<div className=\{styles\.mobileHeader\}/);
  });

  it('replaces the wide contents toggle with a back link only for a checkpoint', () => {
    // The ternary's checkpoint branch renders the back link (or nothing);
    // its ELSE branch is the reader task's original "course ? <ContentsToggle
    // variant=\"wide\" /> : null" — unchanged for every non-quiz kind.
    expect(pageSource).toMatch(/\{isCheckpoint \?\s*\(/);
    expect(pageSource).toMatch(/: course \?\s*\(\s*<ContentsToggle variant="wide" \/>/);
  });

  it('names artboard-spec §7 Q2 as the reason, so the decision stays traceable', () => {
    expect(pageSource).toMatch(/§7 Q2/);
  });
});
