import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import type { E2eFixtures } from '../../tools/src/e2e-seed.ts';

/*
 * THE DIAGNOSIS BEHIND THIS FILE.
 *
 * core-journeys.spec.ts failed roughly one run in eight, always at the same
 * step: mark a lesson complete, click the /me destination, and the event is
 * not in the feed. It was previously "fixed" by removing a plausible false-failure
 * mechanism (a reused web server skipping the seed), and the commit that did
 * so said plainly that this was a hypothesis and not a diagnosis, naming a
 * stale RSC payload as the next suspect. That suspect was right.
 *
 * THE MECHANISM. `markLessonCompleteAction` wrote through to the API and
 * invalidated nothing. `router.refresh()` in MarkCompleteButton refreshes the
 * route the reader is ON — the lesson — and leaves every other entry in the
 * client Router Cache alone. Next prefetches the links in the viewport, and
 * `/me` is in the nav on every page (labelled "Home" since the design
 * import; "Dashboard" when this was diagnosed), so it is usually already
 * cached, fetched BEFORE the completion. Clicking it then renders that
 * payload: a feed with no event on it.
 *
 * WHY ONE RUN IN EIGHT. Whether the prefetch had landed before the click,
 * which depends on idle time and network scheduling — nothing the test
 * controls, and nothing that makes it a test problem. A real reader who
 * finishes a lesson and clicks through to /me sees the same stale page.
 *
 * WHY THIS SPEC AND NOT A RETRY. The failure was intermittent because the
 * prefetch was a race, not because the bug was. This forces the prefetch that
 * the flake merely usually got, so the condition is deterministic: it fails
 * every run without the fix and passes every run with it.
 */
const fixtures: E2eFixtures = JSON.parse(readFileSync(new URL('../.fixtures.json', import.meta.url), 'utf8'));
const LESSON = `/courses/${fixtures.courseSlug}/lessons/${fixtures.lessonSlug}`;

test.describe.configure({ mode: 'serial' });

async function signIn(page: Page, next: string) {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel('Email').fill(fixtures.feedUser.email);
  await page.getByLabel('Password').fill(fixtures.feedUser.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/^(?!.*\/login).*$/);
}

test('the dashboard shows the completion immediately, even when it was already prefetched', async ({ page }) => {
  await signIn(page, LESSON);
  await expect(page.getByRole('heading', { name: 'Getting started', level: 1 })).toBeVisible();

  // FORCE the race the flake used to win by accident. Hovering a Link makes
  // Next prefetch it on the spot, so /me is in the client Router Cache —
  // fetched before the completion below — every time rather than most times.
  const home = page.getByRole('link', { name: 'Home' });
  await home.hover();
  await page.waitForTimeout(1000);

  await page.getByRole('button', { name: 'Mark complete' }).click();
  await expect(page.getByText('Completed')).toBeVisible();

  await home.click();
  await expect(page).toHaveURL(/\/me$/);

  // No reload, no waiting: this is the click a reader makes, and the feed has
  // to be current. Adding `page.reload()` here would make the test pass
  // against the bug, which is exactly how a stale-cache defect survives a
  // test suite.
  await expect(page.getByRole('heading', { name: 'Recent activity' })).toBeVisible();
  await expect(page.getByText('Completed “Getting started” in E2E Course')).toBeVisible();
});

test('Home is the merged dashboard, and what moved to the profile stayed there', async ({ page }) => {
  /*
   * WHAT THIS ASSERTION IS FOR, AND HOW IT CHANGED.
   *
   * It used to read "the dashboard is the feed and nothing else": /me had
   * been the profile in disguise, rendering the same four things from the
   * same data, and the whole change WAS the absence.
   *
   * Phase 3 of the design import merges the other direction. Dashboard is
   * gone as a destination and Home absorbs it
   * (docs/design/2026-09-02-artboard-spec.md §2), so the feed is now one
   * block of six and "nothing else" is false by design. The plan's
   * acceptance for that task is that NOTHING IS SILENTLY DROPPED, so the
   * positive half below names every block M1 draws — a section that
   * disappears in a later phase fails here rather than in a screenshot.
   *
   * The negative half is unchanged and is still the original point: the
   * heatmap grid, the badge shelf and the degree LIST live on /u/{handle},
   * and putting any of them back here would fail nothing else in this
   * suite. "Degree progress" is a card, not the list — it is one degree's
   * pip bar, which M1 draws on Home; the list with its requirements and
   * prerequisites is the profile's.
   */
  await signIn(page, '/me');
  await expect(page).toHaveURL(/\/me$/);

  // Every block the M1 artboard draws, top to bottom.
  await expect(page.getByRole('heading', { name: 'Where you left off' })).toBeAttached();
  await expect(page.getByText(/Times (shown|are shown) in/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recent activity' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Up next' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your courses' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Browse catalog/ }).first()).toBeVisible();

  /*
   * DEGREE PROGRESS IS NOT ASSERTED HERE, and it is the one M1 block this
   * test cannot cover. The seed truncates `badges, degrees cascade`
   * (tools/src/e2e-seed.ts), so no account in this suite holds a degree and
   * the card is correctly absent. Giving it one means adding a degree
   * fixture to a seed six other spec files share — a change with its own
   * blast radius, not a line in this test. src/lib/home.test.ts covers the
   * derivation (`degreeTally`, `pickDegree`) instead.
   */

  // The things that moved to the profile, still gone.
  await expect(page.getByRole('grid', { name: /Activity heatmap/ })).toHaveCount(0);
  for (const heading of ['Badges', 'Degrees']) {
    await expect(page.getByRole('heading', { name: heading, exact: true }), heading).toHaveCount(0);
  }

  // And the way back to them, so they are not reachable only by remembering
  // to open a menu.
  await expect(page.getByRole('link', { name: /on your profile/ })).toBeVisible();
});
