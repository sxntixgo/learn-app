import { describe, it, expect } from 'vitest';
import type { ProfileSections } from './api';
import { anySectionHasContent, sectionHasContent } from './profile-sections.ts';

const heatmap = { days: [], maxCount: 0, currentStreak: 0, longestStreak: 0, timezone: 'UTC' };

describe('sectionHasContent', () => {
  it('is false for a section the owner has hidden', () => {
    // Absent, not empty: §11 omits a private section entirely rather than
    // sending an empty one for the client to hide.
    const sections: ProfileSections = {};
    for (const key of ['badges', 'degrees', 'courses', 'activity_feed', 'activity_heatmap'] as const) {
      expect(sectionHasContent(sections, key), key).toBe(false);
    }
  });

  it('is false for a shared section with nothing in it', () => {
    // The case this module exists for: a new account used to show four
    // headings in a row, each apologising for having nothing under it.
    const sections: ProfileSections = {
      badges: [],
      degrees: [],
      activity_feed: [],
      courses: { completed: [], inProgress: [] },
    };
    expect(sectionHasContent(sections, 'badges')).toBe(false);
    expect(sectionHasContent(sections, 'degrees')).toBe(false);
    expect(sectionHasContent(sections, 'activity_feed')).toBe(false);
    expect(sectionHasContent(sections, 'courses')).toBe(false);
  });

  it('is true as soon as a section has one item', () => {
    expect(sectionHasContent({ badges: [{ slug: 'b', title: 'B' }] } as unknown as ProfileSections, 'badges')).toBe(true);
    expect(sectionHasContent({ degrees: [{ slug: 'd', title: 'D' }] } as unknown as ProfileSections, 'degrees')).toBe(true);
    expect(sectionHasContent({ activity_feed: [{ type: 'lesson_completed' }] } as unknown as ProfileSections, 'activity_feed')).toBe(
      true,
    );
  });

  it('counts courses in progress, not only completed ones', () => {
    // Either list makes the section worth showing — the easy mistake here is
    // to check only `completed`, which hides the section from exactly the
    // person who has just started.
    const onlyInProgress = {
      courses: { completed: [], inProgress: [{ slug: 'c', title: 'C', completedLessons: 1, totalLessons: 9 }] },
    } as unknown as ProfileSections;
    expect(sectionHasContent(onlyInProgress, 'courses')).toBe(true);

    const onlyCompleted = {
      courses: { completed: [{ slug: 'c', title: 'C', completedLessons: 9, totalLessons: 9 }], inProgress: [] },
    } as unknown as ProfileSections;
    expect(sectionHasContent(onlyCompleted, 'courses')).toBe(true);
  });

  it('keeps a shared heatmap even when the year is blank', () => {
    // Deliberately unlike the others: a blank grid already reads as "nothing
    // yet" without a sentence apologising for it, and it is the one section
    // whose empty state is itself informative.
    expect(sectionHasContent({ activity_heatmap: heatmap } as unknown as ProfileSections, 'activity_heatmap')).toBe(
      true,
    );
  });
});

describe('anySectionHasContent', () => {
  it('is false when everything is hidden', () => {
    expect(anySectionHasContent({})).toBe(false);
  });

  it('is false when everything shared is empty', () => {
    // The page's fallback sentence depends on this: "hasn't shared anything"
    // is as true of an account with five empty sections as of one with five
    // hidden ones.
    expect(
      anySectionHasContent({
        badges: [],
        degrees: [],
        activity_feed: [],
        courses: { completed: [], inProgress: [] },
      } as unknown as ProfileSections),
    ).toBe(false);
  });

  it('is true when a single section has one thing in it', () => {
    expect(anySectionHasContent({ badges: [], degrees: [{ slug: 'd', title: 'D' }] } as unknown as ProfileSections)).toBe(true);
  });
});
