import { readFileSync } from 'node:fs';
import { test, expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import type { E2eFixtures } from '../../tools/src/e2e-seed.ts';
import { E2E_COURSE_TAG } from '../../tools/src/e2e-seed.ts';
import { NAV_SIDEBAR_FROM_PX } from '../../web/src/lib/heatmap.ts';

// Phase 15 task 1's proof-of-life spec.
//
// This exists to prove the harness works, not to cover a user journey —
// Phase 15 task 2 writes the real ones (register via invite, browse the
// catalog, enrol, read a lesson, mark it complete). Kept deliberately small
// and honest: one navigation, one assertion on something a real visitor
// would actually see.
//
// An anonymous visit to `/` is the smallest true end-to-end check available.
// The catalog page's own server-side render calls the real API
// (`fetchCourses`, web/app/page.tsx) with no session — `course:list`
// (api/src/policy/can.ts) has no anonymous case at all — so the API refuses
// it and web/src/lib/require-auth.ts redirects to `/login`. That round trip
// only completes if the built web app, the real API server, and the seeded
// Postgres database (playwright.config.ts's webServer entries) are all
// actually up and wired together; nothing here is mocked or stubbed.
test('an anonymous visit to the catalog redirects to sign in', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveURL(/\/login(\?|$)/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

/*
 * CATALOG (M2 wide, P3 narrow), MEASURED — Phase 3's "browsing only" task
 * (docs/plans/2026-09-02-design-import-plan.md, docs/design/2026-09-02-
 * artboard-spec.md §2, §4).
 *
 * WHY THIS FILE HAS A DEDICATED "no progress banner" TEST. The plan's
 * acceptance line names it explicitly: "a spec asserts no progress banner
 * renders on Catalog (it moved to Home, and having it in both places is
 * what the redesign fixed)." Home (the Phase 3 task just before this one)
 * is where "Where you left off" lives now (web/app/me/ResumeBanner.tsx);
 * this file is what stops it coming back to `/` uncaught, the same way a
 * silently-reintroduced banner would have shipped before this task if
 * nothing measured its absence.
 *
 * WHY viewportUser AND NOT A DEDICATED ACCOUNT. This spec is read-only — it
 * never enrolls, completes, or mutates anything — and six other spec files
 * already sign in as viewportUser for exactly that kind of read
 * (shell-layout.spec.ts, shell-banner-rail.spec.ts, session.spec.ts,
 * a11y.spec.ts among them). A dedicated account earns its keep only when a
 * spec MUTATES what it signs in as (see e2e-seed.ts's comments on
 * homeUser/avatarUser/sessionUser); this one does not, so it follows the
 * existing convention rather than growing the fixture file for no reason.
 *
 * WHY THE FILTER IS EXERCISED WITH ONE TAG, NOT FIVE COURSES. The extracted
 * spec's "all five courses" describes the ARTBOARD's mock content, not a
 * fixture this repo owns — tools/src/e2e-seed.ts seeds one course
 * end-to-end (module, lesson, enrollments, submissions all key off it), and
 * duplicating that machinery for a second course was judged out of
 * proportion to what this file needs to prove: that `?tag=` actually
 * narrows the list, and that an unmatched tag narrows it to zero rather
 * than silently ignoring the filter. `E2E_COURSE_TAG` (e2e-seed.ts) is the
 * one real tag the seeded course carries for exactly this.
 */

const fixturesPath = new URL('../.fixtures.json', import.meta.url);
const fixtures: E2eFixtures = JSON.parse(readFileSync(fixturesPath, 'utf8'));

const WIDTHS = [
  { name: 'iPhone', width: 375, height: 812 },
  { name: 'iPad portrait', width: 834, height: 1194 },
  { name: 'iPad landscape', width: 1194, height: 834 },
  { name: 'Desktop', width: 1440, height: 900 },
] as const;

function tierOf(width: number): 'narrow' | 'wide' {
  return width >= NAV_SIDEBAR_FROM_PX ? 'wide' : 'narrow';
}

// Serial, and signed in exactly once — the same reason home.spec.ts and
// viewport.spec.ts give: five concurrent Argon2id logins reproduced a flake
// in another spec twice.
test.describe.configure({ mode: 'serial' });

let catalogState: Awaited<ReturnType<BrowserContext['storageState']>>;

test.beforeAll(async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await page.goto(`/login?next=${encodeURIComponent('/')}`);
  await page.getByLabel('Email').fill(fixtures.viewportUser.email);
  await page.getByLabel('Password').fill(fixtures.viewportUser.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/$/);
  catalogState = await context.storageState();
  await context.close();
});

async function withCatalog<T>(
  browser: Browser,
  baseURL: string | undefined,
  viewport: { width: number; height: number },
  run: (page: Page) => Promise<T>,
  path = '/',
): Promise<T> {
  const context = await browser.newContext({ baseURL, storageState: catalogState, viewport });
  try {
    const page = await context.newPage();
    await page.goto(path);
    await expect(page.getByRole('heading', { name: 'Catalog', level: 1 })).toBeVisible();
    return await run(page);
  } finally {
    await context.close();
  }
}

/**
 * "Present" means it occupies pixels, not that it is in the DOM.
 *
 * `toBeVisible()` alone would pass for an element the layout has collapsed to
 * zero width — precisely what a mis-specified grid column does. So both:
 * visible AND a real box.
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

  test(`every M2 element renders at ${width} (${name}, ${tier} tier)`, async ({ browser, baseURL }) => {
    await withCatalog(browser, baseURL, { width, height }, async (page) => {
      // ---- THE DELIVERABLE: no progress banner, at this width, in this
      // theme's default. "Where you left off" is Home's region name
      // (ResumeBanner.tsx) and must not exist here at all — not zero-sized,
      // not visually hidden, ABSENT.
      await expect(page.getByRole('region', { name: 'Where you left off' })).toHaveCount(0);
      await expect(page.getByText('Where you left off')).toHaveCount(0);
      // And no stats tiles either — Streak / This week were the banner's,
      // and nothing else on this page has a reason to say either word.
      await expect(page.getByText('Streak', { exact: false })).toHaveCount(0);
      await expect(page.getByText('This week', { exact: false })).toHaveCount(0);

      // ---- The filter row (src/lib/catalog.ts): "All courses" plus one
      // chip per tag actually present on the returned courses.
      const filters = page.getByRole('navigation', { name: 'Filter by tag' });
      await expectRendered(filters, 'the filter row');
      await expectRendered(filters.getByRole('link', { name: 'All courses' }), 'the "All courses" filter');
      await expectRendered(filters.getByRole('link', { name: E2E_COURSE_TAG, exact: true }), 'the seeded tag filter');

      // ---- The course list itself: at least the seeded course, rendered
      // exactly once (a CSS-hidden per-tier duplicate would satisfy a bare
      // toBeVisible() but put the title in the page twice for a screen
      // reader).
      await expect(page.getByRole('heading', { name: 'E2E Course', level: 2 })).toHaveCount(1);
      await expectRendered(page.getByRole('link', { name: /E2E Course/ }).first(), 'the seeded course card');

      // ---- And the page fits its viewport. 375 is where this fails first.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, 'the page scrolls horizontally').toBeLessThanOrEqual(1);
    });
  });

  test(`the ${tier} tier's Catalog column at ${width}`, async ({ browser, baseURL }) => {
    await withCatalog(browser, baseURL, { width, height }, async (page) => {
      // Measured, not read off the stylesheet: page.module.css caps the
      // narrow column at 60ch and widens it to 1160px at 1024px+. Asserting
      // the RENDERED width (rather than trusting the source CSS) is what
      // would have caught the 1024px boundary being wired to the old 768px
      // literal, the exact class of bug artboard-spec §3 warns about.
      //
      // `main > div`, not `main`: the shell wraps every route in the one
      // <main> (app/_shell/Shell.tsx) and this page's own top-level element
      // is a <div> (Phase 6's landmark-duplication fix removed the second,
      // nested <main> this used to be) — its only child, so this selects
      // Catalog's own content column rather than the shell's full-bleed one.
      const main = page.locator('main > div');
      const box = await expectRendered(main, 'the catalog main column');

      if (tier === 'narrow') {
        expect(box.width, 'narrow column is unexpectedly wide').toBeLessThan(700);
      } else {
        expect(box.width, 'wide column did not widen past the narrow cap').toBeGreaterThan(750);
      }
    });
  });
}

test('selecting a tag keeps the courses that carry it', async ({ browser, baseURL }) => {
  await withCatalog(browser, baseURL, { width: 1440, height: 900 }, async (page) => {
    const filters = page.getByRole('navigation', { name: 'Filter by tag' });
    const chip = filters.getByRole('link', { name: E2E_COURSE_TAG, exact: true });
    await expect(chip).toHaveAttribute('data-active', 'false');

    await chip.click();
    await expect(page).toHaveURL(new RegExp(`\\?tag=${E2E_COURSE_TAG}$`));
    await expect(page.getByRole('heading', { name: 'Catalog', level: 1 })).toBeVisible();

    // Still there — it carries the tag we just selected.
    await expect(page.getByRole('heading', { name: 'E2E Course', level: 2 })).toBeVisible();
    // And the chip now marks itself the active one (border + weight, design
    // §14.2's "gold is structural only, never a fill" — data-active carries
    // the state, not a colour alone).
    await expect(filters.getByRole('link', { name: E2E_COURSE_TAG, exact: true })).toHaveAttribute(
      'data-active',
      'true',
    );
  }, '/');
});

test('a tag no course carries narrows the list to a dedicated empty state', async ({ browser, baseURL }) => {
  await withCatalog(
    browser,
    baseURL,
    { width: 375, height: 812 },
    async (page) => {
      await expect(page.getByRole('heading', { name: 'E2E Course', level: 2 })).toHaveCount(0);
      // Distinct from "No courses yet." (courses.length === 0) — this is
      // "courses exist, none carry THIS tag", and the two must not read the
      // same to someone who cannot see which one is true.
      await expect(page.getByText('No courses match this filter.')).toBeVisible();
      await expect(page.getByText('No courses yet.')).toHaveCount(0);
    },
    '/?tag=not-a-real-tag-e2e',
  );
});
