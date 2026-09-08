import { describe, it, expect } from 'vitest';
import type { BadgeProgress } from './api.ts';
import { badgesSectionHasContent } from '../../app/u/[handle]/BadgesSection.tsx';

/*
 * THE TRIPWIRE THIS PINS DOWN.
 *
 * `/api/v1/me/badges` enumerates every badge definition on the instance
 * against the caller — earned or not, because a badge is instance-wide
 * curriculum rather than a possession. So `ownerBadges.length` answers "how
 * many badges exist here", never "how many this account has".
 *
 * Testing that length is what puts a "0 of 9" Badges section on EVERY owner's
 * profile the moment anyone seeds a badge, including an account with nothing
 * in it — which is precisely what `profile-empty.spec.ts` exists to catch. The
 * degrees half of the same page hit exactly this collision in Phase 4 and is
 * guarded by `hasRealProgress`.
 *
 * A browser test cannot hold this down: `clearAwardableState` truncates
 * `badges` at the top of every seed, so a badge inserted before a Playwright
 * run is gone before the first page loads. (Verified — two runs "passed" with
 * a seeded badge that the harness had already deleted.) The guard is a pure
 * function, so it is pinned here instead, where the precondition is a literal.
 */

function badge(slug: string, earned: boolean): BadgeProgress {
  return {
    slug,
    title: slug,
    description: null,
    courseSlug: null,
    criteria: { type: 'course_completed', course: 'a-course' },
    earned,
    awardedAt: earned ? '2026-09-08T00:00:00.000Z' : null,
    progress: { current: earned ? 1 : 0, target: 1, percent: earned ? 100 : 0, unit: 'lessons' },
  };
}

describe('badgesSectionHasContent', () => {
  it('is false for an owner who has earned nothing, however many badges the instance defines', () => {
    // The tripwire condition: badges exist, this account has none of them.
    const ownerBadges = [badge('first', false), badge('second', false), badge('third', false)];
    expect(badgesSectionHasContent({ ownerBadges, publicBadges: undefined })).toBe(false);
  });

  it('is true as soon as one is earned, so the locked ones still render beside it', () => {
    // PL9/P9 draws locked badges and a "3 of 9" tally. The guard decides only
    // whether the SECTION appears — it never filters what BadgeShelf shows.
    const ownerBadges = [badge('earned', true), badge('locked', false)];
    expect(badgesSectionHasContent({ ownerBadges, publicBadges: undefined })).toBe(true);
  });

  it('is false for an owner with no badge definitions at all', () => {
    expect(badgesSectionHasContent({ ownerBadges: [], publicBadges: undefined })).toBe(false);
  });

  it('uses length for the public view, where the payload is earned-only by design', () => {
    // `ProfileBadge` omits unearned badges entirely (api/src/profile/load.ts),
    // so a non-empty public list already means real badges — no guard needed.
    expect(badgesSectionHasContent({ ownerBadges: null, publicBadges: [] })).toBe(false);
    expect(
      badgesSectionHasContent({
        ownerBadges: null,
        publicBadges: [{ slug: 'x', title: 'x', description: null, awardedAt: null, courseSlug: null }],
      }),
    ).toBe(true);
  });
});
