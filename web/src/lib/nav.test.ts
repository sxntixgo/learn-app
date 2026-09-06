import { describe, expect, it } from 'vitest';
import {
  isNavActive,
  MANAGE_DESTINATIONS,
  NAV_DESTINATIONS,
  visibleNavDestinations,
  type NavDestination,
} from './nav';

const catalog = NAV_DESTINATIONS.find((d) => d.href === '/')!;
const search = NAV_DESTINATIONS.find((d) => d.href === '/search')!;
const home = NAV_DESTINATIONS.find((d) => d.href === '/me')!;
const grading = MANAGE_DESTINATIONS.find((d) => d.href === '/grading')!;
const admin = MANAGE_DESTINATIONS.find((d) => d.href === '/admin/imports')!;
const invites = MANAGE_DESTINATIONS.find((d) => d.href === '/invites')!;

const FULL_AUDIENCE = { isTeacher: true, canInvite: true, isAdmin: true, canSearch: true };

describe('NAV_DESTINATIONS', () => {
  it('is exactly Home, Catalog, Search — the three everyday destinations, in that order', () => {
    // Order is the assertion, not just membership: Home first because it is
    // where a session starts.
    expect(NAV_DESTINATIONS.map((d) => d.href)).toEqual(['/me', '/', '/search']);
  });

  it('reads Home · Catalog · Search — the imported design\'s IA (artboard spec §2)', () => {
    // The labels, not just the routes: the design import changed the IA by
    // renaming one destination, and a rename is the only thing that could
    // silently undo it. Home is at `/me` by the assumption documented on
    // NAV_DESTINATIONS (spec §7 Q1, option (a)); if that assumption is ever
    // reversed, this and nav-labels.test.ts are what say so.
    expect(NAV_DESTINATIONS.map((d) => d.label)).toEqual(['Home', 'Catalog', 'Search']);
  });

  it('holds no role-gated destination — those live in MANAGE_DESTINATIONS', () => {
    // The sidebar is for everyone. A link that almost nobody may follow is
    // not everyday navigation, and putting one back here would quietly undo
    // the split.
    for (const destination of NAV_DESTINATIONS) {
      expect(destination.restrictedToTeacher, `${destination.label} is role-gated`).toBeUndefined();
      expect(destination.restrictedToInviter, `${destination.label} is role-gated`).toBeUndefined();
      expect(destination.restrictedToAdmin, `${destination.label} is role-gated`).toBeUndefined();
    }
  });
});

describe('MANAGE_DESTINATIONS', () => {
  it('is exactly Grading, Invitations, and Admin', () => {
    expect(MANAGE_DESTINATIONS.map((d) => d.href)).toEqual(['/grading', '/invites', '/admin/imports']);
  });

  it('gates every one of them — an ungated entry here would be invisible to nobody', () => {
    for (const destination of MANAGE_DESTINATIONS) {
      const gated =
        destination.restrictedToTeacher === true ||
        destination.restrictedToInviter === true ||
        destination.restrictedToAdmin === true;
      expect(gated, `${destination.label} is in Manage but gated to nobody`).toBe(true);
    }
  });

  it('shares no href with the sidebar, so nothing is offered in two places', () => {
    const sidebar = new Set(NAV_DESTINATIONS.map((d) => d.href));
    expect(MANAGE_DESTINATIONS.filter((d) => sidebar.has(d.href))).toEqual([]);
  });

  it('labels the admin destination clearly as admin', () => {
    expect(admin.label).toBe('Admin');
  });

  it('marks Grading, and only Grading, restricted to teachers', () => {
    expect(grading.restrictedToTeacher).toBe(true);
    expect(catalog.restrictedToTeacher).toBeUndefined();
    expect(search.restrictedToTeacher).toBeUndefined();
    expect(home.restrictedToTeacher).toBeUndefined();
    expect(admin.restrictedToTeacher).toBeUndefined();
    expect(invites.restrictedToTeacher).toBeUndefined();
  });

  it('marks Admin restricted to admins — the API has always refused everyone else', () => {
    expect(admin.restrictedToAdmin).toBe(true);
    expect(catalog.restrictedToAdmin).toBeUndefined();
    expect(search.restrictedToAdmin).toBeUndefined();
    expect(grading.restrictedToAdmin).toBeUndefined();
    expect(invites.restrictedToAdmin).toBeUndefined();
  });

  it('marks Invitations restricted to inviters, not to teachers — admin is exclusive of teacher (§5.1)', () => {
    expect(invites.restrictedToInviter).toBe(true);
    expect(grading.restrictedToInviter).toBeUndefined();
    expect(search.restrictedToInviter).toBeUndefined();
  });

  it('marks Search, and only Search, restricted to search — same grant as course:list, not a role name', () => {
    expect(search.restrictedToSearch).toBe(true);
    expect(catalog.restrictedToSearch).toBeUndefined();
    expect(home.restrictedToSearch).toBeUndefined();
    expect(grading.restrictedToSearch).toBeUndefined();
    expect(invites.restrictedToSearch).toBeUndefined();
    expect(admin.restrictedToSearch).toBeUndefined();
  });
});

describe('visibleNavDestinations', () => {
  const student = { isTeacher: false, canInvite: false, isAdmin: false, canSearch: true };

  it('leaves a student with Home, Catalog, and Search only', () => {
    expect(visibleNavDestinations(student).map((d) => d.href)).toEqual(['/me', '/', '/search']);
  });

  it('gives a student NOTHING in the Manage section', () => {
    expect(visibleNavDestinations(student, MANAGE_DESTINATIONS)).toEqual([]);
  });

  it('filters the Manage list by the same gate as the sidebar', () => {
    // One predicate, two lists. A second copy could disagree, and a
    // destination visible in one place but hidden in the other is a
    // permissions bug that looks like a rendering bug.
    const teacher = { isTeacher: true, canInvite: false, isAdmin: false, canSearch: false };
    expect(visibleNavDestinations(teacher, MANAGE_DESTINATIONS).map((d) => d.href)).toEqual(['/grading']);
    expect(visibleNavDestinations(FULL_AUDIENCE, MANAGE_DESTINATIONS).map((d) => d.href)).toEqual([
      '/grading',
      '/invites',
      '/admin/imports',
    ]);
  });

  it('keeps all three, in order, for an account that is everything', () => {
    expect(visibleNavDestinations(FULL_AUDIENCE).map((d) => d.href)).toEqual(['/me', '/', '/search']);
  });

  it('gives an admin no Search — admin holds neither the student nor the teacher role (§5.1)', () => {
    const admin = { isTeacher: false, canInvite: true, isAdmin: true, canSearch: false };
    expect(visibleNavDestinations(admin).map((d) => d.href)).toEqual(['/me', '/']);
    expect(visibleNavDestinations(admin, MANAGE_DESTINATIONS).map((d) => d.href)).toEqual([
      '/invites',
      '/admin/imports',
    ]);
  });

  it('gives a teacher Grading and Invitations to manage, but never Admin', () => {
    const teacher = { isTeacher: true, canInvite: true, isAdmin: false, canSearch: false };
    expect(visibleNavDestinations(teacher).map((d) => d.href)).toEqual(['/me', '/']);
    expect(visibleNavDestinations(teacher, MANAGE_DESTINATIONS).map((d) => d.href)).toEqual([
      '/grading',
      '/invites',
    ]);
  });

  it('drops Invitations from a teacher who cannot issue any', () => {
    const teacher = { isTeacher: true, canInvite: false, isAdmin: false, canSearch: false };
    expect(visibleNavDestinations(teacher, MANAGE_DESTINATIONS).map((d) => d.href)).toEqual(['/grading']);
  });

  it('decides Search by canSearch, not by isTeacher — roles are a set', () => {
    // A teacher who also learns still gets Search; the grant is the same one
    // as course:list, not a role name.
    const teacherWhoLearns = { isTeacher: true, canInvite: false, isAdmin: false, canSearch: true };
    expect(visibleNavDestinations(teacherWhoLearns).map((d) => d.href)).toEqual(['/me', '/', '/search']);
    expect(visibleNavDestinations(teacherWhoLearns, MANAGE_DESTINATIONS).map((d) => d.href)).toEqual(['/grading']);
  });
});

describe('isNavActive', () => {
  it('matches Catalog only at the exact root, not every path', () => {
    expect(isNavActive('/', catalog)).toBe(true);
    expect(isNavActive('/me', catalog)).toBe(false);
  });

  it('keeps Catalog active while drilling into a course via its declared prefix', () => {
    expect(isNavActive('/courses/intro-to-ts', catalog)).toBe(true);
    expect(isNavActive('/courses/intro-to-ts/lessons/setup', catalog)).toBe(true);
  });

  it('matches Home exactly and on its own sub-routes', () => {
    expect(isNavActive('/me', home)).toBe(true);
    expect(isNavActive('/me/settings', home)).toBe(true);
    expect(isNavActive('/', home)).toBe(false);
    expect(isNavActive('/courses/intro-to-ts', home)).toBe(false);
  });

  it('does not match a path that merely starts with the same characters', () => {
    const merch: NavDestination = { href: '/me', label: 'Home' };
    expect(isNavActive('/merch', merch)).toBe(false);
  });

  it('matches Admin exactly and on its own sub-routes, but not the catalog or home', () => {
    expect(isNavActive('/admin/imports', admin)).toBe(true);
    expect(isNavActive('/admin/imports/stream', admin)).toBe(true);
    expect(isNavActive('/', admin)).toBe(false);
    expect(isNavActive('/me', admin)).toBe(false);
  });

  it('keeps Admin active on the other admin screens, which are not under its href', () => {
    expect(isNavActive('/admin/people', admin)).toBe(true);
    expect(isNavActive('/admin/audit', admin)).toBe(true);
  });

  it('matches Invitations, but not the accept page a single link points at', () => {
    expect(isNavActive('/invites', invites)).toBe(true);
    expect(isNavActive('/invite/some-token', invites)).toBe(false);
  });

  it('matches Grading exactly and while grading one submission, but not the catalog or home', () => {
    expect(isNavActive('/grading', grading)).toBe(true);
    expect(isNavActive('/grading/anything', grading)).toBe(true);
    expect(isNavActive('/', grading)).toBe(false);
    expect(isNavActive('/me', grading)).toBe(false);
  });
});
