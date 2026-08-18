import { describe, it, expect } from 'vitest';
import type { BadgeProgress, DegreeProgress } from './api';
import {
  announceAwards,
  badgeStatusLabel,
  describeDegreeProgress,
  describeProgress,
  formatAwardedAt,
} from './badges';

function badge(overrides: Partial<BadgeProgress> = {}): BadgeProgress {
  return {
    slug: 'a-badge',
    title: 'A Badge',
    description: null,
    courseSlug: null,
    criteria: { type: 'lessons_completed', count: 5 },
    earned: false,
    awardedAt: null,
    progress: { current: 3, target: 5, percent: 60, unit: 'lessons' },
    ...overrides,
  } as BadgeProgress;
}

function degree(overrides: Partial<DegreeProgress> = {}): DegreeProgress {
  return {
    slug: 'a-degree',
    title: 'A Degree',
    description: null,
    earned: false,
    awardedAt: null,
    required: [
      { slug: 'one', title: 'One', imported: true, completed: true },
      { slug: 'two', title: 'Two', imported: true, completed: false },
    ],
    electives: null,
    satisfiable: true,
    missingCourses: [],
    percent: 50,
    ...overrides,
  } as DegreeProgress;
}

describe('describeProgress', () => {
  it('counts in the criterion’s own unit', () => {
    expect(describeProgress({ current: 3, target: 5, percent: 60, unit: 'lessons' })).toBe('3 of 5 lessons');
  });

  it('phrases a percentage as a percentage, not as a count of "percents"', () => {
    expect(describeProgress({ current: 62, target: 90, percent: 68, unit: 'percent' })).toBe(
      '62% of the 90% needed',
    );
  });

  it('rounds for display — a track score is a real quotient', () => {
    expect(describeProgress({ current: 66.6666, target: 90, percent: 74, unit: 'percent' })).toBe(
      '67% of the 90% needed',
    );
  });
});

describe('badgeStatusLabel', () => {
  // The label is the STRUCTURAL half of earned-vs-locked: colour alone would
  // fail WCAG 1.4.1, so every card renders this word.
  it('names the state in words', () => {
    expect(badgeStatusLabel(badge({ earned: true }))).toBe('Earned');
    expect(badgeStatusLabel(badge({ earned: false }))).toBe('Locked');
  });

  it('says Earned even when the criteria are no longer met — badges are never revoked', () => {
    const retuned = badge({
      earned: true,
      awardedAt: '2026-08-01T00:00:00.000Z',
      progress: { current: 3, target: 500, percent: 1, unit: 'lessons' },
    });
    expect(badgeStatusLabel(retuned)).toBe('Earned');
  });
});

describe('describeDegreeProgress', () => {
  it('counts required courses', () => {
    expect(describeDegreeProgress(degree())).toBe('1 of 2 required courses');
  });

  it('adds electives only when the degree declares them', () => {
    const withElectives = degree({
      electives: {
        choose: 2,
        from: [
          { slug: 'e1', title: 'E1', imported: true, completed: true },
          { slug: 'e2', title: 'E2', imported: true, completed: false },
        ],
        completed: 1,
      },
    });
    expect(describeDegreeProgress(withElectives)).toBe('1 of 2 required courses · 1 of 2 electives');
  });

  it('clamps electives completed to the number the degree asks for', () => {
    const overshoot = degree({
      electives: { choose: 1, from: [], completed: 3 },
    });
    expect(describeDegreeProgress(overshoot)).toContain('1 of 1 electives');
  });
});

describe('announceAwards', () => {
  it('is null when nothing was earned, so no live region is rendered at all', () => {
    expect(announceAwards({ badges: [], degrees: [] })).toBeNull();
  });

  it('names every badge and degree earned by this write', () => {
    expect(
      announceAwards({ badges: [{ title: 'The Complexity Eye' }], degrees: [{ title: 'Reviewer' }] }),
    ).toBe('Badge earned: The Complexity Eye. Degree earned: Reviewer.');
  });
});

describe('formatAwardedAt', () => {
  it('formats in the actor’s own timezone, not the server’s', () => {
    // 00:30 UTC on the 16th is still the 15th in Denver (UTC-6).
    const instant = '2026-08-16T00:30:00.000Z';
    expect(formatAwardedAt(instant, 'America/Denver')).toBe('Aug 15, 2026');
    expect(formatAwardedAt(instant, 'UTC')).toBe('Aug 16, 2026');
  });

  it('passes null through — a locked badge has no award date', () => {
    expect(formatAwardedAt(null, 'UTC')).toBeNull();
  });
});
