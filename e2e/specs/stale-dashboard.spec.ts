import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import type { E2eFixtures } from '../../tools/src/e2e-seed.ts';

/*
 * THE DIAGNOSIS BEHIND THIS FILE.
 *
 * core-journeys.spec.ts failed roughly one run in eight, always at the same
 * step: mark a lesson complete, click Dashboard, and the event is not in the
 * feed. It was previously "fixed" by removing a plausible false-failure
 * mechanism (a reused web server skipping the seed), and the commit that did
 * so said plainly that this was a hypothesis and not a diagnosis, naming a
 * stale RSC payload as the next suspect. That suspect was right.
 *
 * THE MECHANISM. `markLessonCompleteAction` wrote through to the API and
 * invalidated nothing. `router.refresh()` in MarkCompleteButton refreshes the
 * route the reader is ON — the lesson — and leaves every other entry in the
 * client Router Cache alone. Next prefetches the links in the viewport, and
 * "Dashboard" is in the nav on every page, so `/me` is usually already
 * cached, fetched BEFORE the completion. Clicking it then renders that
 * payload: a dashboard with no event on it.
 *
 * WHY ONE RUN IN EIGHT. Whether the prefetch had landed before the click,
 * which depends on idle time and network scheduling — nothing the test
 * controls, and nothing that makes it a test problem. A real reader who
 * finishes a lesson and clicks Dashboard sees the same stale page.
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
  const dashboard = page.getByRole('link', { name: 'Dashboard' });
  await dashboard.hover();
  await page.waitForTimeout(1000);

  await page.getByRole('button', { name: 'Mark complete' }).click();
  await expect(page.getByText('Completed')).toBeVisible();

  await dashboard.click();
  await expect(page).toHaveURL(/\/me$/);

  // No reload, no waiting: this is the click a reader makes, and the feed has
  // to be current. Adding `page.reload()` here would make the test pass
  // against the bug, which is exactly how a stale-cache defect survives a
  // test suite.
  await expect(page.getByRole('heading', { name: 'Recent activity' })).toBeVisible();
  await expect(page.getByText('Completed “Getting started” in E2E Course')).toBeVisible();
});

test('the dashboard is the feed and nothing else', async ({ page }) => {
  /*
   * The point of splitting /me from the profile was that the two had been
   * rendering the same four things from the same data. Every remaining
   * "Activity heatmap" assertion in this suite is now on the profile, so
   * putting the grid — or the badge shelf, or the degree list — back on the
   * dashboard would fail nothing at all.
   *
   * This is that assertion. It is a negative, which normally earns its keep
   * poorly; here the whole change IS the absence.
   */
  await signIn(page, '/me');
  await expect(page).toHaveURL(/\/me$/);

  // The one thing it should have.
  await expect(page.getByRole('heading', { name: 'Recent activity' })).toBeVisible();

  // The things that moved to the profile.
  await expect(page.getByRole('grid', { name: /Activity heatmap/ })).toHaveCount(0);
  for (const heading of ['Badges', 'Degrees']) {
    await expect(page.getByRole('heading', { name: heading, exact: true }), heading).toHaveCount(0);
  }

  // And the way back to them, so they are not reachable only by remembering
  // to open a menu.
  await expect(page.getByRole('link', { name: /on your profile/ })).toBeVisible();
});
