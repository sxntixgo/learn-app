import { describe, expect, it } from 'vitest';
import { isNavActive, NAV_DESTINATIONS, type NavDestination } from './nav';

const catalog = NAV_DESTINATIONS.find((d) => d.href === '/')!;
const dashboard = NAV_DESTINATIONS.find((d) => d.href === '/me')!;

describe('NAV_DESTINATIONS', () => {
  it('is exactly Catalog and Dashboard', () => {
    expect(NAV_DESTINATIONS.map((d) => d.href)).toEqual(['/', '/me']);
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
});
