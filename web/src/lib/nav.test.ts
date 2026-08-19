import { describe, expect, it } from 'vitest';
import { isNavActive, NAV_DESTINATIONS, visibleNavDestinations, type NavDestination } from './nav';

const catalog = NAV_DESTINATIONS.find((d) => d.href === '/')!;
const dashboard = NAV_DESTINATIONS.find((d) => d.href === '/me')!;
const grading = NAV_DESTINATIONS.find((d) => d.href === '/grading')!;
const admin = NAV_DESTINATIONS.find((d) => d.href === '/admin/imports')!;
const invites = NAV_DESTINATIONS.find((d) => d.href === '/invites')!;

describe('NAV_DESTINATIONS', () => {
  it('is exactly Catalog, Dashboard, Grading, Invitations, and Admin', () => {
    expect(NAV_DESTINATIONS.map((d) => d.href)).toEqual(['/', '/me', '/grading', '/invites', '/admin/imports']);
  });

  it('labels the admin destination clearly as admin', () => {
    expect(admin.label).toBe('Admin');
  });

  it('marks Grading, and only Grading, restricted to teachers', () => {
    expect(grading.restrictedToTeacher).toBe(true);
    expect(catalog.restrictedToTeacher).toBeUndefined();
    expect(dashboard.restrictedToTeacher).toBeUndefined();
    expect(admin.restrictedToTeacher).toBeUndefined();
    expect(invites.restrictedToTeacher).toBeUndefined();
  });

  it('marks Admin restricted to admins — the API has always refused everyone else', () => {
    expect(admin.restrictedToAdmin).toBe(true);
    expect(catalog.restrictedToAdmin).toBeUndefined();
    expect(grading.restrictedToAdmin).toBeUndefined();
    expect(invites.restrictedToAdmin).toBeUndefined();
  });

  it('marks Invitations restricted to inviters, not to teachers — admin is exclusive of teacher (§5.1)', () => {
    expect(invites.restrictedToInviter).toBe(true);
    expect(grading.restrictedToInviter).toBeUndefined();
  });
});

describe('visibleNavDestinations', () => {
  const student = { isTeacher: false, canInvite: false, isAdmin: false };

  it('leaves a student with Catalog and Dashboard only', () => {
    expect(visibleNavDestinations(student).map((d) => d.href)).toEqual(['/', '/me']);
  });

  it('keeps every destination, in order, for an account that is all three', () => {
    expect(visibleNavDestinations({ isTeacher: true, canInvite: true, isAdmin: true }).map((d) => d.href)).toEqual([
      '/',
      '/me',
      '/grading',
      '/invites',
      '/admin/imports',
    ]);
  });

  it('gives an admin Invitations and Admin, and no Grading — admin is exclusive of teacher (§5.1)', () => {
    expect(visibleNavDestinations({ isTeacher: false, canInvite: true, isAdmin: true }).map((d) => d.href)).toEqual([
      '/',
      '/me',
      '/invites',
      '/admin/imports',
    ]);
  });

  it('gives a teacher Grading and Invitations, but never Admin', () => {
    expect(visibleNavDestinations({ isTeacher: true, canInvite: true, isAdmin: false }).map((d) => d.href)).toEqual([
      '/',
      '/me',
      '/grading',
      '/invites',
    ]);
  });

  it('drops Invitations from a teacher who cannot list any', () => {
    expect(visibleNavDestinations({ isTeacher: true, canInvite: false, isAdmin: false }).map((d) => d.href)).toEqual([
      '/',
      '/me',
      '/grading',
    ]);
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

  it('matches Dashboard exactly and on its own sub-routes', () => {
    expect(isNavActive('/me', dashboard)).toBe(true);
    expect(isNavActive('/me/settings', dashboard)).toBe(true);
    expect(isNavActive('/', dashboard)).toBe(false);
    expect(isNavActive('/courses/intro-to-ts', dashboard)).toBe(false);
  });

  it('does not match a path that merely starts with the same characters', () => {
    const merch: NavDestination = { href: '/me', label: 'Dashboard' };
    expect(isNavActive('/merch', merch)).toBe(false);
  });

  it('matches Admin exactly and on its own sub-routes, but not the catalog or dashboard', () => {
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

  it('matches Grading exactly and while grading one submission, but not the catalog or dashboard', () => {
    expect(isNavActive('/grading', grading)).toBe(true);
    expect(isNavActive('/grading/anything', grading)).toBe(true);
    expect(isNavActive('/', grading)).toBe(false);
    expect(isNavActive('/me', grading)).toBe(false);
  });
});
