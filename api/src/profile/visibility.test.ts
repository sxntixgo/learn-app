import { describe, it, expect } from 'vitest';
import {
  PROFILE_SECTIONS,
  SECTION_VISIBILITIES,
  isProfileSection,
  parseVisibility,
  visibilityMapFrom,
  isSectionVisibleTo,
  visibleSectionsFor,
  ALL_PRIVATE,
} from './visibility.ts';
import type { ProfileSection, ViewerRelation } from './visibility.ts';

const VIEWERS: readonly ViewerRelation[] = ['owner', 'signed_in', 'anonymous'];

describe('the section vocabulary', () => {
  it('is exactly migration 0014’s five sections', () => {
    expect([...PROFILE_SECTIONS]).toEqual(['badges', 'degrees', 'courses', 'activity_feed', 'activity_heatmap']);
  });

  it('keeps the feed and the heatmap apart — they are different exposures (§11)', () => {
    expect(PROFILE_SECTIONS).toContain('activity_feed');
    expect(PROFILE_SECTIONS).toContain('activity_heatmap');
  });

  it('rejects anything outside it', () => {
    expect(isProfileSection('badges')).toBe(true);
    expect(isProfileSection('badge')).toBe(false);
    expect(isProfileSection('')).toBe(false);
    expect(isProfileSection('__proto__')).toBe(false);
    expect(isProfileSection(null)).toBe(false);
    expect(isProfileSection(7)).toBe(false);
  });

  it('has exactly three visibility values', () => {
    expect([...SECTION_VISIBILITIES]).toEqual(['private', 'signed_in', 'public']);
  });
});

describe('parseVisibility — anything unrecognised is private', () => {
  it('accepts the three known values', () => {
    expect(parseVisibility('private')).toBe('private');
    expect(parseVisibility('signed_in')).toBe('signed_in');
    expect(parseVisibility('public')).toBe('public');
  });

  it('falls back to private for junk, never to public', () => {
    for (const junk of [null, undefined, '', 'PUBLIC', 'Public', 'everyone', 0, 1, true, {}, []]) {
      expect(parseVisibility(junk), JSON.stringify(junk)).toBe('private');
    }
  });
});

describe('visibilityMapFrom — an ABSENT row means private', () => {
  it('returns every section as private for a user with no rows at all', () => {
    expect(visibilityMapFrom([])).toEqual(ALL_PRIVATE);
    for (const section of PROFILE_SECTIONS) {
      expect(visibilityMapFrom([])[section]).toBe('private');
    }
  });

  it('applies only the sections that have rows, leaving the rest closed', () => {
    const map = visibilityMapFrom([
      { section: 'badges', visibility: 'public' },
      { section: 'degrees', visibility: 'signed_in' },
    ]);
    expect(map).toEqual({
      badges: 'public',
      degrees: 'signed_in',
      courses: 'private',
      activity_feed: 'private',
      activity_heatmap: 'private',
    });
  });

  it('ignores a row naming a section the code does not know', () => {
    const map = visibilityMapFrom([
      { section: 'study_groups', visibility: 'public' },
      { section: '__proto__', visibility: 'public' },
    ]);
    expect(map).toEqual(ALL_PRIVATE);
    // The prototype is untouched: a row cannot inject a sixth section.
    expect(Object.getPrototypeOf(map)).toBe(null);
  });

  it('closes a row whose stored visibility is not one of the three', () => {
    expect(visibilityMapFrom([{ section: 'badges', visibility: 'friends-only' }]).badges).toBe('private');
  });
});

describe('isSectionVisibleTo', () => {
  it('shows the owner everything, whatever the setting says', () => {
    for (const visibility of SECTION_VISIBILITIES) {
      expect(isSectionVisibleTo(visibility, 'owner'), visibility).toBe(true);
    }
  });

  it('shows a signed-in viewer only signed_in and public', () => {
    expect(isSectionVisibleTo('private', 'signed_in')).toBe(false);
    expect(isSectionVisibleTo('signed_in', 'signed_in')).toBe(true);
    expect(isSectionVisibleTo('public', 'signed_in')).toBe(true);
  });

  it('shows an anonymous viewer only public', () => {
    expect(isSectionVisibleTo('private', 'anonymous')).toBe(false);
    expect(isSectionVisibleTo('signed_in', 'anonymous')).toBe(false);
    expect(isSectionVisibleTo('public', 'anonymous')).toBe(true);
  });

  it('is monotonic: anything an anonymous viewer sees, a signed-in one sees too', () => {
    for (const visibility of SECTION_VISIBILITIES) {
      if (isSectionVisibleTo(visibility, 'anonymous')) {
        expect(isSectionVisibleTo(visibility, 'signed_in'), visibility).toBe(true);
        expect(isSectionVisibleTo(visibility, 'owner'), visibility).toBe(true);
      }
    }
  });

  it('denies a viewer relation it does not recognise', () => {
    expect(isSectionVisibleTo('public', 'lurker' as ViewerRelation)).toBe(false);
  });
});

describe('visibleSectionsFor', () => {
  it('is empty for every non-owner when nothing was ever set', () => {
    expect([...visibleSectionsFor(ALL_PRIVATE, 'anonymous')]).toEqual([]);
    expect([...visibleSectionsFor(ALL_PRIVATE, 'signed_in')]).toEqual([]);
  });

  it('is the full section list for the owner when nothing was ever set', () => {
    const sections: ProfileSection[] = [...visibleSectionsFor(ALL_PRIVATE, 'owner')];
    expect(sections.sort()).toEqual([...PROFILE_SECTIONS].sort());
  });

  it('narrows as the viewer gets further away', () => {
    const map = visibilityMapFrom([
      { section: 'badges', visibility: 'public' },
      { section: 'degrees', visibility: 'signed_in' },
      { section: 'courses', visibility: 'private' },
    ]);
    const byViewer = Object.fromEntries(
      VIEWERS.map((viewer) => [viewer, [...visibleSectionsFor(map, viewer)].sort()]),
    );
    expect(byViewer.anonymous).toEqual(['badges']);
    expect(byViewer.signed_in).toEqual(['badges', 'degrees']);
    expect(byViewer.owner).toEqual([...PROFILE_SECTIONS].sort());
  });
});
