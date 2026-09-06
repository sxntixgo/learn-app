import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { MANAGE_DESTINATIONS, NAV_DESTINATIONS, type NavDestination } from './nav';

/**
 * A DESTINATION'S LABEL IS THE HEADING OF THE PAGE IT OPENS.
 *
 * Not a style rule. A sidebar entry reading "Dashboard" that opens a page
 * headed "Your desk" makes a reader stop and ask whether they landed where
 * they meant to — and the answer is only ever "yes", so the question is pure
 * cost. Three had drifted apart: Catalog opened "Learn App", Dashboard opened
 * "Your desk", and the account menu's "Account & password" opened "Account".
 *
 * Checked by reading the page sources, which is the same technique
 * tools/src/docker-web.test.ts uses for wiring it cannot execute here.
 * Rendering these pages would need a session, a database and a server; the
 * heading is a literal in the file, and a literal is what this compares.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '../..');

/** Where a route's page component lives. */
function pageFileFor(href: string): string {
  const segment = href === '/' ? '' : href;
  return path.join(webRoot, 'app', segment, 'page.tsx');
}

/**
 * The page's own `<h1>`, with entities decoded so `&amp;` compares equal to
 * the `&` a label is written with.
 */
function headingOf(href: string): string {
  const source = readFileSync(pageFileFor(href), 'utf8');
  const match = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(source);
  if (!match) throw new Error(`No <h1> found in ${pageFileFor(href)}`);
  return match[1]!
    .replace(/\{'\s*'\}/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Destinations whose label deliberately differs from the heading, each with
 * the reason. An allowlist rather than a loosened assertion: every entry is a
 * decision someone made, and a new one should have to be argued for.
 */
const DELIBERATE_EXCEPTIONS: ReadonlyMap<string, string> = new Map([
  [
    '/admin/imports',
    'Admin is a SECTION, not a page — AdminNav names the pages inside it (Imports, People, Audit), and the entry lands on the first one.',
  ],
]);

function check(destinations: readonly NavDestination[], listName: string): void {
  describe(listName, () => {
    for (const destination of destinations) {
      const exception = DELIBERATE_EXCEPTIONS.get(destination.href);

      it(`${exception ? 'deliberately differs from' : 'matches'} the heading of ${destination.href}`, () => {
        const heading = headingOf(destination.href);
        if (exception) {
          // Pinned in the other direction, so the exception cannot quietly
          // become the norm: if someone later makes these agree, this fails
          // and the entry gets removed from the list above.
          expect(heading, `${destination.href}: ${exception}`).not.toBe(destination.label);
          return;
        }
        expect(heading, `the sidebar/menu says "${destination.label}" but the page is headed "${heading}"`).toBe(
          destination.label,
        );
      });
    }
  });
}

check(NAV_DESTINATIONS, 'every sidebar destination');
check(MANAGE_DESTINATIONS, 'every Manage destination');

/**
 * The account menu's own settings links. They are literals in the component
 * rather than entries in nav.ts — they are not navigation destinations, they
 * are places to change something about yourself — so they are listed here.
 * "Account & password" opening a page headed "Account" is the mismatch that
 * prompted all of this.
 */
describe('the account menu settings links', () => {
  const menu = readFileSync(path.join(webRoot, 'app', '_shell', 'AccountMenu.tsx'), 'utf8');

  for (const [href, expected] of [
    ['/settings/profile', 'Profile & visibility'],
    ['/settings/account', 'Account & password'],
  ] as const) {
    it(`offers "${expected}" and opens a page headed the same`, () => {
      // Both halves asserted: that the menu still says this, and that the
      // page still agrees. Checking only the page would let the menu drift.
      const inMenu = menu.includes(`href="${href}"`);
      expect(inMenu, `AccountMenu no longer links to ${href}`).toBe(true);
      expect(headingOf(href)).toBe(expected);
    });
  }
});
