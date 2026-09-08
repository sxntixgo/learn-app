import { readFileSync } from 'node:fs';
import { test, expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import type { E2eFixtures } from '../../tools/src/e2e-seed.ts';
import { NAV_SIDEBAR_FROM_PX } from '../../web/src/lib/heatmap.ts';

/*
 * COURSE & SYLLABUS (PL3 wide, P4 narrow) — Phase 3's last remaining reading-
 * core task (docs/plans/2026-09-02-design-import-plan.md, docs/design/2026-
 * 09-02-artboard-spec.md §4). Acceptance: "renders to artboard at four
 * widths; no raw colour survives lint." The lint half is
 * tools/check-css-tokens.mjs (npm run lint); this file is the four-widths
 * half, measured the way home.spec.ts and catalog.spec.ts already do it —
 * `boundingBox()` in a real browser, never `display` read off a stylesheet,
 * because a collapsed grid column passes `toBeVisible()` just fine.
 *
 * WHY homeUser AND NOT viewportUser. viewportUser carries no enrolment
 * (home.spec.ts's own comment explains why: its Home is the empty state),
 * so signing in as it would render this page's `.actions` with only the
 * "Enrol" button and skip `.progressSummary` entirely — `page.tsx` only
 * renders it when `progress.totalLessons > 0`, which needs an enrolment to
 * even ask the question. homeUser (tools/src/e2e-seed.ts) is already
 * enrolled in the seeded course with nothing completed, so it exercises the
 * "Leave course" state and a real 0%-complete progress bar without adding a
 * new fixture account for a screen that already has one to reuse.
 *
 * NO TRACK CHIPS HERE. The seeded course carries no `tracks` row (only
 * catalog.spec.ts's filter needs a tag, and tags and tracks are different
 * columns), so `.tracks` never renders for it — same shape as home.spec.ts
 * leaving Degree progress unasserted for a fixture that cannot populate it,
 * recorded rather than silently skipped.
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
// catalog.spec.ts give: concurrent Argon2id logins reproduced a flake in
// another spec twice.
test.describe.configure({ mode: 'serial' });

let courseState: Awaited<ReturnType<BrowserContext['storageState']>>;

test.beforeAll(async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  const coursePath = `/courses/${fixtures.courseSlug}`;
  await page.goto(`/login?next=${encodeURIComponent(coursePath)}`);
  await page.getByLabel('Email').fill(fixtures.homeUser.email);
  await page.getByLabel('Password').fill(fixtures.homeUser.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(new RegExp(`${coursePath}$`));
  courseState = await context.storageState();
  await context.close();
});

async function withCourse<T>(
  browser: Browser,
  baseURL: string | undefined,
  viewport: { width: number; height: number },
  run: (page: Page) => Promise<T>,
): Promise<T> {
  const context = await browser.newContext({ baseURL, storageState: courseState, viewport });
  try {
    const page = await context.newPage();
    await page.goto(`/courses/${fixtures.courseSlug}`);
    await expect(page.getByRole('heading', { name: 'E2E Course', level: 1 })).toBeVisible();
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
async function expectRendered(
  locator: Locator,
  label: string,
): Promise<{ x: number; y: number; width: number; height: number }> {
  await expect(locator, `${label} is not visible`).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${label} has no bounding box`).not.toBeNull();
  expect(box!.width, `${label} rendered ${box!.width}px wide`).toBeGreaterThan(0);
  expect(box!.height, `${label} rendered ${box!.height}px tall`).toBeGreaterThan(0);
  return box!;
}

for (const { name, width, height } of WIDTHS) {
  const tier = tierOf(width);

  test(`every PL3/P4 element renders at ${width} (${name}, ${tier} tier)`, async ({ browser, baseURL }) => {
    await withCourse(browser, baseURL, { width, height }, async (page) => {
      // ---- Actions: homeUser is already enrolled, so the button reads
      // "Leave course" (EnrolButton.tsx), rendered exactly once.
      await expect(page.getByRole('button', { name: 'Leave course' })).toHaveCount(1);
      await expectRendered(page.getByRole('button', { name: 'Leave course' }), 'the leave-course button');

      // ---- Progress summary: homeUser has an enrolment and nothing
      // completed, so this is a real "0 / 2 lessons complete (0%)" render,
      // not a fixture accident — `page.tsx` only shows it when
      // `progress.totalLessons > 0`.
      await expect(page.getByText(/lessons complete/)).toHaveCount(1);
      await expectRendered(page.getByText(/lessons complete/), 'the progress summary');
      await expectRendered(page.getByRole('img', { name: /percent of lessons complete/ }), 'the progress bar');

      // ---- The table of contents: both seeded modules, each exactly
      // once (a CSS-hidden per-tier duplicate would satisfy a bare
      // toBeVisible() but put the heading in the page twice for a screen
      // reader).
      await expect(page.getByRole('heading', { name: 'E2E Module', level: 2 })).toHaveCount(1);
      await expect(page.getByRole('heading', { name: 'E2E Exercise Module', level: 2 })).toHaveCount(1);
      await expectRendered(page.getByRole('link', { name: /Getting started/ }), 'the seeded lesson row');
      await expectRendered(page.getByRole('link', { name: /Add two numbers/ }), 'the seeded exercise lesson row');

      // ---- And the page fits its viewport. 375 is where this fails first.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, 'the page scrolls horizontally').toBeLessThanOrEqual(1);
    });
  });

  test(`the ${tier} tier's Course column at ${width}`, async ({ browser, baseURL }) => {
    await withCourse(browser, baseURL, { width, height }, async (page) => {
      // Measured, not read off the stylesheet: course.module.css caps the
      // narrow column at 60ch (~480px in this page's serif context) and
      // widens it to a flat 640px at 1024px+, the same 1024px boundary as
      // every other restyled Phase 3 screen. Asserting the RENDERED width
      // is what would catch that boundary being wired to the old 768px
      // literal, the exact class of bug artboard-spec §3 warns about.
      //
      // `main > div`, not `main`: the shell wraps every route in the one
      // <main> (app/_shell/Shell.tsx) and this page's own top-level element
      // is a <div> (Phase 6's landmark-duplication fix removed the second,
      // nested <main> this used to be) — its only child, so this selects
      // Course's own content column rather than the shell's full-bleed one,
      // the same reasoning catalog.spec.ts already documents.
      const main = page.locator('main > div');
      const box = await expectRendered(main, 'the course main column');

      if (tier === 'narrow') {
        expect(box.width, 'narrow column is unexpectedly wide').toBeLessThan(550);
      } else {
        expect(box.width, 'wide column did not widen past the narrow cap').toBeGreaterThan(550);
      }
    });
  });
}
