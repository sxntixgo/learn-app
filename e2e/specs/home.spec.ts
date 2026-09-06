import { readFileSync } from 'node:fs';
import { test, expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { E2eFixtures } from '../../tools/src/e2e-seed.ts';
import { NAV_SIDEBAR_FROM_PX } from '../../web/src/lib/heatmap.ts';

/*
 * HOME (M1 wide, P2 narrow) — the merged screen, measured.
 *
 * WHAT THIS FILE IS FOR. Phase 3 of the design import merges the dashboard
 * into Home (docs/design/2026-09-02-artboard-spec.md §2), and the plan names
 * the failure mode for that task exactly: "a quietly dropped element rather
 * than a broken layout". A dropped element does not throw, does not fail a
 * type check and does not fail a unit test — it just is not there, at one
 * tier, in one theme, and the page still looks fine. So the acceptance is
 * "every element the M1 artboard shows is present at BOTH TIERS", and this
 * file is that assertion, made the only way it can be made honestly:
 * `boundingBox()` in a real browser at four real widths, never `display` read
 * off a stylesheet.
 *
 * WHY IT IS NOT IN viewport.spec.ts. That file's subject is the heatmap
 * window and the shell, it is already the longest-running spec in the suite,
 * and it signs in as `viewportUser` — an account with no enrolment, whose
 * Home is therefore the EMPTY state. Home's artboard is a populated screen;
 * proving it needs a populated account, which is `homeUser`
 * (tools/src/e2e-seed.ts, and see its comment for why it is dedicated).
 *
 * THE TIER BOUNDARY IS IMPORTED, NOT TYPED. `NAV_SIDEBAR_FROM_PX` is the
 * TypeScript half of the 1024px constant documented in
 * app/_shell/nav.module.css's header, and web/src/lib/heatmap.test.ts pins
 * the two together. Writing `1024` here — or, as three specs used to,
 * `768` — would make this file the next thing to drift when the boundary
 * moves.
 *
 * ⚠️ DEGREE PROGRESS IS THE ONE M1 BLOCK NOT ASSERTED HERE. Degrees are
 * GLOBAL definitions: `listDegreeProgress` (api/src/progression/views.ts)
 * joins every row of `degrees` against the viewer, so seeding one degree
 * would put a Degrees section on EVERY seeded account's profile and break
 * profile-empty.spec.ts, whose subject is that an account with nothing in it
 * shows no sections. That is Phase 4's file and Phase 4's fixture decision.
 * Until then the card's derivations are covered without a browser in
 * web/src/lib/home.test.ts (`degreeTally`, `pickDegree`), and its absence is
 * recorded in the Phase 3 outcome rather than left to be re-discovered.
 */

const fixturesPath = new URL('../.fixtures.json', import.meta.url);
const fixtures: E2eFixtures = JSON.parse(readFileSync(fixturesPath, 'utf8'));

/*
 * The four artboard widths (artboard-spec §3): iPhone and iPad portrait are
 * the narrow tier, iPad landscape and Desktop the wide one. `tier` is
 * DERIVED rather than declared, so a width added here cannot be filed under
 * the wrong tier by hand.
 */
const WIDTHS = [
  { name: 'iPhone', width: 375, height: 812 },
  { name: 'iPad portrait', width: 834, height: 1194 },
  { name: 'iPad landscape', width: 1194, height: 834 },
  { name: 'Desktop', width: 1440, height: 900 },
] as const;

function tierOf(width: number): 'narrow' | 'wide' {
  return width >= NAV_SIDEBAR_FROM_PX ? 'wide' : 'narrow';
}

/*
 * Serial, and signed in exactly once — the same two reasons viewport.spec.ts
 * gives at length. Sign-in is a deliberate Argon2id hash (design §13), and
 * five concurrent ones under `fullyParallel` reproduced a flake in ANOTHER
 * spec file twice.
 */
test.describe.configure({ mode: 'serial' });

let homeState: Awaited<ReturnType<BrowserContext['storageState']>>;

test.beforeAll(async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await page.goto(`/login?next=${encodeURIComponent('/me')}`);
  await page.getByLabel('Email').fill(fixtures.homeUser.email);
  await page.getByLabel('Password').fill(fixtures.homeUser.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/me$/);
  homeState = await context.storageState();
  await context.close();
});

async function withHome<T>(
  browser: Browser,
  baseURL: string | undefined,
  viewport: { width: number; height: number },
  run: (page: Page) => Promise<T>,
): Promise<T> {
  const context = await browser.newContext({ baseURL, storageState: homeState, viewport });
  try {
    const page = await context.newPage();
    await page.goto('/me');
    await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();
    return await run(page);
  } finally {
    await context.close();
  }
}

/**
 * "Present" means it occupies pixels, not that it is in the DOM.
 *
 * `toBeVisible()` alone would pass for an element the layout has collapsed to
 * zero width — which is precisely what a mis-specified grid column does, and
 * precisely the failure a stylesheet reading cannot see. So both: visible AND
 * a real box.
 */
async function expectRendered(locator: Locator, label: string): Promise<{ x: number; y: number; width: number; height: number }> {
  await expect(locator, `${label} is not visible`).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${label} has no bounding box`).not.toBeNull();
  expect(box!.width, `${label} rendered ${box!.width}px wide`).toBeGreaterThan(0);
  expect(box!.height, `${label} rendered ${box!.height}px tall`).toBeGreaterThan(0);
  return box!;
}

for (const { name, width, height } of WIDTHS) {
  const tier = tierOf(width);

  test(`every M1 element renders at ${width} (${name}, ${tier} tier)`, async ({ browser, baseURL }) => {
    await withHome(browser, baseURL, { width, height }, async (page) => {
      // ---- Resume banner: percent, module/lesson eyebrow, title, course,
      // two statistics, and the action. The artboard's whole top block.
      const banner = page.getByRole('region', { name: 'Where you left off' });
      await expectRendered(banner, 'resume banner');
      await expectRendered(banner.getByText(/^\d+%$/).first(), 'resume percent');
      await expectRendered(banner.getByText(/Module \d+ · Lesson \d+/), 'resume eyebrow (module · lesson)');
      await expectRendered(banner.getByText('Getting started', { exact: true }), 'resume lesson title');
      await expectRendered(banner.getByText('E2E Course', { exact: true }), 'resume course title');
      await expectRendered(banner.getByText('Streak', { exact: false }).first(), 'streak statistic');
      await expectRendered(banner.getByText('This week', { exact: false }).first(), 'this-week statistic');
      await expectRendered(banner.getByRole('link', { name: /Resume/ }), 'Resume action');

      // The streak is a real number off a real event, not a rendered zero:
      // the fixture's one activity event is dated today (e2e-seed.ts).
      await expect(banner.getByRole('listitem').first()).toContainText(/[1-9]/);

      // ---- The timezone line. M1 draws it directly under the banner.
      await expectRendered(page.getByText(/Times (are )?shown in/), 'timezone line');

      // ---- Recent activity, with at least the enrolment the fixture wrote.
      const feed = page.getByRole('region', { name: 'Recent activity' });
      await expectRendered(feed, 'Recent activity section');
      await expectRendered(feed.getByText(/Enrolled in/).first(), 'an activity row');

      // ---- Up next: both numbered rows. Two, because the fixture has
      // finished nothing and UP_NEXT_COUNT is 2 (web/app/me/page.tsx).
      const upNext = page.getByRole('region', { name: 'Up next' });
      await expectRendered(upNext, 'Up next section');
      await expect(upNext.getByRole('listitem')).toHaveCount(2);
      await expectRendered(upNext.getByText('01', { exact: true }), 'Up next row number 01');
      await expectRendered(upNext.getByText('02', { exact: true }), 'Up next row number 02');

      // ---- Your courses: the section rule's action, one numbered row, its
      // progress bar and its count.
      const courses = page.getByRole('region', { name: 'Your courses' });
      await expectRendered(courses, 'Your courses section');
      await expectRendered(courses.getByRole('link', { name: /Browse catalog/ }), 'Browse catalog link');
      const courseRow = courses.getByRole('listitem').first();
      await expectRendered(courseRow, 'a course row');
      await expectRendered(courseRow.getByRole('link', { name: 'E2E Course' }), 'the course row title link');
      await expect(courseRow).toContainText('0/2');
      /*
       * The progress bar's TRACK, located structurally because it carries no
       * text and no role of its own: CourseList.tsx's row is
       * number / body / progress, and the progress cell is track-then-count.
       * The track and not the fill, deliberately — this fixture's course is
       * at 0%, so its fill is legitimately zero wide while a collapsed track
       * is the regression worth catching. It is invisible in the markup and
       * in a screenshot alike, which is why it is measured.
       */
      const track = courseRow.locator(':scope > span').nth(2).locator(':scope > span').first();
      const trackBox = await expectRendered(track, 'the course progress bar');
      expect(trackBox.width, 'progress bar collapsed').toBeGreaterThan(4);

      /*
       * ---- The line out to the profile. Not an M1 element — it is what
       * `/me` carried BEFORE this task, the one route to the badges,
       * degrees and heatmap that moved to /u/{handle}. The plan's acceptance
       * is that nothing on the old page is lost without being named, so it
       * is asserted here rather than trusted to survive.
       */
      await expectRendered(
        page.getByRole('link', { name: /badges, degrees and activity grid are on your profile/ }),
        'the link out to the profile',
      );

      // ---- Nothing is duplicated per tier. A CSS-hidden second copy of a
      // block would satisfy every assertion above and put every number in
      // the page twice for a screen reader.
      for (const heading of ['Recent activity', 'Up next', 'Your courses']) {
        await expect(page.getByRole('heading', { name: heading, exact: true }), heading).toHaveCount(1);
      }

      // ---- And the page fits its viewport. 375 is where this fails first.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, 'the page scrolls horizontally').toBeLessThanOrEqual(1);
    });
  });

  test(`the ${tier} tier's Home layout at ${width} (${name})`, async ({ browser, baseURL }) => {
    await withHome(browser, baseURL, { width, height }, async (page) => {
      const banner = page.getByRole('region', { name: 'Where you left off' });
      const percent = await expectRendered(banner.getByText(/^\d+%$/).first(), 'resume percent');
      const stats = await expectRendered(banner.getByRole('list'), 'the banner statistics');
      const feed = await expectRendered(page.getByRole('region', { name: 'Recent activity' }), 'Recent activity');
      const upNext = await expectRendered(page.getByRole('region', { name: 'Up next' }), 'Up next');

      if (tier === 'narrow') {
        /*
         * P2: one column. The statistics fall out of the banner into a tile
         * row BELOW the percent, and Up next sits above the feed — that
         * order is P2's, and it is why me.module.css names grid areas
         * rather than using `order` (which cannot express the wide tier's
         * row span).
         */
        expect(stats.y, 'the statistics are not below the percent').toBeGreaterThan(percent.y + percent.height - 1);
        expect(upNext.y + upNext.height, 'Up next does not sit above the feed').toBeLessThanOrEqual(feed.y + 1);
        expect(Math.abs(feed.x - upNext.x), 'the band is not one column').toBeLessThanOrEqual(1);
      } else {
        /*
         * M1: the banner is a single row — percent, identity, statistics,
         * action — and the band is two columns with the feed on the left.
         */
        expect(stats.x, 'the statistics are not beside the percent').toBeGreaterThan(percent.x + percent.width - 1);
        expect(feed.x + feed.width, 'the feed is not left of Up next').toBeLessThanOrEqual(upNext.x + 1);
        expect(upNext.y, 'the band is not two columns').toBeLessThan(feed.y + feed.height);
      }
    });
  });
}

/*
 * One axe scan, at the narrow tier, on the POPULATED screen.
 *
 * a11y.spec.ts already scans /me, but it does so as `viewportUser` — no
 * enrolment, so no Up next, no course rows, no progress bars — and at this
 * project's default 1280px viewport. Everything Phase 3 added to this page is
 * therefore unscanned by that file. Narrow rather than wide because the
 * markup is identical at both tiers by design (that is the point of the
 * merge), so a second scan would re-scan the same tree, while narrow is the
 * tier whose 44px targets and reflowed banner are new.
 *
 * Same bar as a11y.spec.ts: critical violations fail, everything else is
 * reported. Narrowing the rule set to pass would hide the finding.
 */
test('axe: the populated Home at 375', async ({ browser, baseURL }) => {
  await withHome(browser, baseURL, { width: 375, height: 812 }, async (page) => {
    const results = await new AxeBuilder({ page }).analyze();
    console.log(`[a11y] home (375, populated): ${results.violations.length} violation(s)`);
    for (const v of results.violations) {
      console.log(`[a11y]   ${v.impact ?? 'unknown'} — ${v.id}: ${v.help} (${v.nodes.length} node(s)) ${v.helpUrl}`);
    }
    const critical = results.violations.filter((v) => v.impact === 'critical');
    expect(
      critical,
      `Critical accessibility violations on the populated Home:\n${critical
        .map((v) => `- ${v.id}: ${v.help} (${v.nodes.length} node(s)) ${v.helpUrl}`)
        .join('\n')}`,
    ).toEqual([]);
  });
});
