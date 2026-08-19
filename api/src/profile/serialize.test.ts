import { describe, it, expect } from 'vitest';
import {
  PUBLIC_PROFILE_FIELDS,
  avatarSeed,
  serializeProfileForViewer,
  serializePublicProfile,
  serializeProfile,
} from './serialize.ts';
import type { ProfileModel } from './serialize.ts';
import { visibilityMapFrom } from './visibility.ts';

// ---------------------------------------------------------------------------
// One model, every section populated, every section OPEN — so that anything
// missing from a payload below is missing because a serializer left it out,
// never because the fixture had nothing to say.
// ---------------------------------------------------------------------------
function modelFixture(overrides: Partial<ProfileModel> = {}): ProfileModel {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    handle: 'santiago',
    // The email is IN THE MODEL on purpose: it is a column on `users`, the
    // loader selects it, and the whole point of the tests below is that it
    // never reaches a payload. A fixture without it could not prove that.
    email: 'santiago@example.test',
    displayName: 'Santiago',
    bio: 'Learning things.',
    joinedAt: '2026-01-02T03:04:05.000Z',
    noindex: false,
    visibility: visibilityMapFrom([
      { section: 'badges', visibility: 'public' },
      { section: 'degrees', visibility: 'public' },
      { section: 'courses', visibility: 'public' },
      { section: 'activity_feed', visibility: 'public' },
      { section: 'activity_heatmap', visibility: 'public' },
    ]),
    sections: {
      badges: [
        {
          slug: 'first-steps',
          title: 'First Steps',
          description: 'Completed a lesson',
          courseSlug: 'intro',
          awardedAt: '2026-02-01T00:00:00.000Z',
        },
      ],
      degrees: [
        {
          slug: 'reviewer',
          title: 'Reviewer',
          description: null,
          earned: false,
          awardedAt: null,
          percent: 33,
        },
      ],
      courses: {
        completed: [{ slug: 'intro', title: 'Intro', totalLessons: 4, completedLessons: 4 }],
        inProgress: [{ slug: 'advanced', title: 'Advanced', totalLessons: 10, completedLessons: 2 }],
      },
      activity_feed: [
        {
          type: 'lesson_completed',
          occurredAt: '2026-02-01T00:00:00.000Z',
          course: { slug: 'intro', title: 'Intro' },
          lesson: { slug: 'hello', title: 'Hello' },
        },
      ],
      activity_heatmap: {
        timezone: 'America/Denver',
        days: [{ date: '2026-02-01', count: 3 }],
        maxCount: 3,
        currentStreak: 1,
        longestStreak: 5,
      },
    },
    ...overrides,
  };
}

/** Every key anywhere in a payload, however deeply nested. */
function allKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, into);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      allKeys(child, into);
    }
  }
  return into;
}

/** Every string anywhere in a payload, however deeply nested. */
function allStrings(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') {
    into.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) allStrings(item, into);
  } else if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) allStrings(child, into);
  }
  return into;
}

describe('the viewer-aware serializer (signed in)', () => {
  it('gives the owner every section, whatever the settings say', () => {
    const model = modelFixture({ visibility: visibilityMapFrom([]) });
    const payload = serializeProfileForViewer(model, 'owner');

    expect(payload.viewer).toBe('owner');
    expect(Object.keys(payload.sections).sort()).toEqual(
      ['activity_feed', 'activity_heatmap', 'badges', 'courses', 'degrees'].sort(),
    );
  });

  it('hands the owner their settings back, so the toggles have something to render', () => {
    const payload = serializeProfileForViewer(modelFixture(), 'owner');
    expect(payload.visibility).toEqual(modelFixture().visibility);
    expect(payload.noindex).toBe(false);
  });

  it('does NOT hand another viewer the settings — how a section is closed is the owner’s business', () => {
    expect(serializeProfileForViewer(modelFixture(), 'signed_in').visibility).toBeUndefined();
    expect(serializePublicProfile(modelFixture()).visibility).toBeUndefined();
  });

  it('OMITS a hidden section from the payload — never sends it for the client to hide', () => {
    const model = modelFixture({
      visibility: visibilityMapFrom([
        { section: 'badges', visibility: 'signed_in' },
        { section: 'activity_heatmap', visibility: 'private' },
      ]),
    });
    const payload = serializeProfileForViewer(model, 'signed_in');

    expect(Object.keys(payload.sections)).toEqual(['badges']);
    expect('activity_heatmap' in payload.sections).toBe(false);
    expect('degrees' in payload.sections).toBe(false);
    // And the hidden data is nowhere else in the payload either.
    expect(allStrings(payload)).not.toContain('America/Denver');
  });

  it('shows a signed-in viewer nothing at all when every section is closed', () => {
    const payload = serializeProfileForViewer(modelFixture({ visibility: visibilityMapFrom([]) }), 'signed_in');
    expect(payload.sections).toEqual({});
    expect(payload.handle).toBe('santiago');
  });
});

describe('the public serializer is an ALLOWLIST, not a filter', () => {
  it('publishes exactly the fields on the allowlist', () => {
    const payload = serializePublicProfile(modelFixture());
    expect(Object.keys(payload).sort()).toEqual([...PUBLIC_PROFILE_FIELDS].sort());
  });

  // =========================================================================
  // THE TEST THIS DESIGN DECISION EXISTS FOR (design §11).
  //
  // A filtering serializer ("fetch the object, delete the private keys") and
  // an allowlist serializer are indistinguishable — they return byte-identical
  // payloads — right up until somebody adds a field to the model. Then the
  // filter publishes it and the allowlist does not. So the test adds one.
  // =========================================================================
  it('does not publish a NEW model field that nobody allowlisted', () => {
    interface FutureProfileModel extends ProfileModel {
      /** Imagine next year's migration: `users.recovery_phone`. */
      recoveryPhone: string;
    }
    const model: FutureProfileModel = { ...modelFixture(), recoveryPhone: '+1-555-0100' };

    // This is the shape the allowlist exists to prevent. A serializer built
    // by spreading the model and deleting known-private keys publishes the
    // new column the day it is added, without anyone deciding to.
    expect({ ...model }).toHaveProperty('recoveryPhone');

    const payload = serializePublicProfile(model);

    expect(allKeys(payload)).not.toContain('recoveryPhone');
    expect(allStrings(payload)).not.toContain('+1-555-0100');
    // The only way to publish it is to add it here, deliberately.
    expect([...PUBLIC_PROFILE_FIELDS]).not.toContain('recoveryPhone');
  });

  it('publishes only the sections set to public', () => {
    const model = modelFixture({
      visibility: visibilityMapFrom([
        { section: 'badges', visibility: 'public' },
        { section: 'degrees', visibility: 'signed_in' },
        { section: 'courses', visibility: 'private' },
      ]),
    });
    const payload = serializePublicProfile(model);
    expect(Object.keys(payload.sections)).toEqual(['badges']);
  });

  it('never links into lesson content — §12: lessons are always behind login', () => {
    const payload = serializePublicProfile(modelFixture());
    const feed = payload.sections.activity_feed ?? [];
    expect(feed).toHaveLength(1);
    expect(feed[0]!.lesson).toEqual({ title: 'Hello' });
    expect(allKeys(feed[0]!.lesson)).not.toContain('slug');
    expect(allStrings(feed[0]!.lesson)).not.toContain('hello');
    // The course, which has a public landing page (§12), keeps its slug.
    expect(feed[0]!.course).toEqual({ slug: 'intro', title: 'Intro' });
  });
});

describe('the email never crosses the boundary — to any viewer, ever', () => {
  for (const viewer of ['owner', 'signed_in', 'anonymous'] as const) {
    it(`is absent for a ${viewer} viewer`, () => {
      const payload = serializeProfile(modelFixture(), viewer);
      expect(allKeys(payload)).not.toContain('email');
      expect(allStrings(payload)).not.toContain('santiago@example.test');
      expect(JSON.stringify(payload)).not.toContain('@example.test');
    });
  }

  it('and the handle is not derived from it (§11)', () => {
    const payload = serializeProfile(modelFixture({ email: 'quiet.person@example.test' }), 'anonymous');
    expect(payload.handle).toBe('santiago');
  });
});

describe('serializeProfile routes to the right serializer', () => {
  it('sends an anonymous viewer through the allowlist', () => {
    const model = modelFixture();
    expect(serializeProfile(model, 'anonymous')).toEqual(serializePublicProfile(model));
  });

  it('sends everyone else through the viewer-aware one', () => {
    const model = modelFixture();
    expect(serializeProfile(model, 'signed_in')).toEqual(serializeProfileForViewer(model, 'signed_in'));
    expect(serializeProfile(model, 'owner')).toEqual(serializeProfileForViewer(model, 'owner'));
  });
});

describe('the avatar is generated, never uploaded (§11.1, scoped)', () => {
  it('is an identicon whose seed is derived from the user id, and is stable', () => {
    const payload = serializeProfile(modelFixture(), 'anonymous');
    expect(payload.avatar.kind).toBe('identicon');
    expect(payload.avatar.seed).toBe(avatarSeed(modelFixture().id));
    expect(payload.avatar.seed).toMatch(/^[0-9a-f]{16}$/);
  });

  it('does not publish the user id itself — the seed is a hash of it, not the row key', () => {
    const model = modelFixture();
    const payload = serializeProfile(model, 'anonymous');
    expect(allStrings(payload)).not.toContain(model.id);
    expect(avatarSeed(model.id)).not.toBe(model.id);
  });

  it('gives two accounts different seeds', () => {
    expect(avatarSeed('11111111-1111-4111-8111-111111111111')).not.toBe(
      avatarSeed('22222222-2222-4222-8222-222222222222'),
    );
  });

  it('is the same seed for every viewer, so the face does not change when you sign in', () => {
    const model = modelFixture();
    expect(serializeProfile(model, 'owner').avatar).toEqual(serializeProfile(model, 'anonymous').avatar);
  });
});
