import { readFileSync } from 'node:fs';
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { E2eFixtures } from '../../tools/src/e2e-seed.ts';
import { HEATMAP_WINDOW_STEPS, visibleWeeksForWidth } from '../../web/src/lib/heatmap.ts';

// Phase 15 task 3: viewport specs at 375 / 834 / 1440 (plan's Phase 15,
// third bullet). Tasks 1 (harness) and 2 (core journeys) are done; this
// file adds the one kind of assertion nothing before it could make —
// computed layout, measured in a real browser, never markup or CSS source.
//
// Every UI claim through Phase 14 was verified by reading served markup,
// which is structurally blind to layout (plan, Phase 15 preamble). This
// file exists to be the check that catches what that could not — and it
// found something. See "the visible window matches..." below.
//
// AUTH, two decisions:
//
// 1. task 2's core-journeys.spec.ts consumes the one seeded platform invite
//    (single-use by design, §13) to prove registration itself works. These
//    specs don't need to exercise registration — they need a signed-in
//    session to reach the heatmap/feed (behind auth, design §10) and the
//    lesson reader — so they sign in as tools/src/e2e-seed.ts's separate
//    `viewportUser` fixture (an already-registered account with a known
//    password) instead of racing task 2 for the invite.
//
// 2. Signing in for real goes through Argon2id (api/src/auth/password.ts),
//    deliberately expensive (design §13). Measured empirically while
//    building this file: five independent `page.goto('/login')` round trips
//    here, running concurrently with core-journeys.spec.ts's own
//    registration (also an Argon2id hash) under this harness's
//    `fullyParallel` config, pushed that OTHER spec's 5s default assertion
//    timeout into a genuine, reproducible flake (`await expect(page).
//    toHaveURL(/\/me$/)` timing out while its "Accepting…" button was still
//    pending) — reproduced twice, gone once this file logs in only once.
//    So: sign in ONE time in `beforeAll`, capture the resulting cookies via
//    `context.storageState()`, and hand every test a fresh context seeded
//    from that captured state instead of a fresh login. No production code
//    or other spec file changes; the fix stays inside this file.

const fixturesPath = new URL('../.fixtures.json', import.meta.url);
const fixtures: E2eFixtures = JSON.parse(readFileSync(fixturesPath, 'utf8'));

const PHONE = { width: 375, height: 812 };
const TABLET = { width: 834, height: 1194 };
const DESKTOP = { width: 1440, height: 900 };

// Forces this whole file onto one worker, running serially. Two reasons,
// both about shared load rather than correctness:
//   1. Guarantees `beforeAll` below signs in exactly once (per-worker
//      `beforeAll` would otherwise re-run — and re-hash — once per worker
//      this file's tests happened to land on).
//   2. Caps this file's OWN peak concurrency at one headless-Chromium
//      context at a time, on top of `beforeAll` already cutting its total
//      Argon2id logins from five to one — see the "AUTH, two decisions"
//      comment above for the concurrency flake this combination was
//      written to stop causing. It does not (and can't) control what other
//      spec files do in their own workers.
test.describe.configure({ mode: 'serial' });

let authState: Awaited<ReturnType<BrowserContext['storageState']>>;

test.beforeAll(async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await page.goto(`/login?next=${encodeURIComponent('/me')}`);
  await page.getByLabel('Email').fill(fixtures.viewportUser.email);
  await page.getByLabel('Password').fill(fixtures.viewportUser.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/me$/);
  authState = await context.storageState();
  await context.close();
});

/** A fresh context/page carrying the one captured signed-in session — no per-test login. */
async function withAuthedPage<T>(
  browser: Browser,
  baseURL: string | undefined,
  viewport: { width: number; height: number },
  run: (page: Page) => Promise<T>,
): Promise<T> {
  const context = await browser.newContext({ baseURL, storageState: authState, viewport });
  try {
    const page = await context.newPage();
    return await run(page);
  } finally {
    await context.close();
  }
}

test.describe('the app shell switches shape at the shell breakpoint', () => {
  // nav.module.css and shell.module.css both key off exactly one
  // `@media (min-width: 768px)`. 375 < 768 (phone side: fixed bottom tab
  // bar). 834 and 1440 are both >= 768 (sidebar side) — 834 (iPad, the
  // plan's explicit "iPad middle case") is 66px past the breakpoint, not
  // straddling it, so which side it lands on is unambiguous from the CSS
  // alone; the assertions below confirm the rendered page agrees.
  const CASES = [
    { ...PHONE, shape: 'fixed bottom tab bar' as const },
    { ...TABLET, shape: 'in-flow sidebar' as const },
    { ...DESKTOP, shape: 'in-flow sidebar' as const },
  ];

  for (const { width, height, shape } of CASES) {
    test(`${width}x${height} renders the ${shape}`, async ({ browser, baseURL }) => {
      await withAuthedPage(browser, baseURL, { width, height }, async (page) => {
        await page.goto('/me');

        const nav = page.getByRole('navigation', { name: 'Primary' });
        await expect(nav).toBeVisible();

        const box = await nav.boundingBox();
        if (!box) throw new Error('Primary nav landmark has no bounding box');
        const position = await nav.evaluate((el) => getComputedStyle(el).position);

        // The sidebar's collapse control (nav.module.css: `.collapseToggle
        // { display: none }`, overridden only inside the >=768px query)
        // exists in the DOM at every width — Nav.tsx always renders it —
        // so this is a real CSS-visibility check, not a markup check.
        const collapseToggle = page.getByRole('button', { name: 'Collapse navigation' });

        if (shape === 'fixed bottom tab bar') {
          expect(position).toBe('fixed');
          // Spans the full viewport width and sits flush against its
          // bottom edge (env(safe-area-inset-bottom) is 0 here, no notch)
          // — the defining shape of a bottom tab bar.
          expect(box.width).toBeGreaterThan(width - 2);
          expect(box.width).toBeLessThanOrEqual(width);
          expect(box.y + box.height).toBeGreaterThan(height - 2);
          await expect(collapseToggle).not.toBeVisible();
        } else {
          expect(position).toBe('sticky');
          // An in-flow column at the left edge, not a full-bleed bar —
          // comfortably narrower than half the viewport at both tablet and
          // desktop widths, and nowhere near the phone bar's full span.
          expect(box.x).toBe(0);
          expect(box.width).toBeGreaterThan(50);
          expect(box.width).toBeLessThan(width / 2);
          await expect(collapseToggle).toBeVisible();
        }
      });
    });
  }
});

test.describe('the contribution heatmap window (design §10)', () => {
  /**
   * Counts week columns whose entire column sits inside the scroller's own
   * unclipped box — i.e. genuinely visible without scrolling, not merely
   * present somewhere in the DOM. Every viewport renders the SAME roughly-53
   * week columns in the DOM at all times (Heatmap.tsx: "the server renders
   * all 53 weeks... reached by scrolling, with no second request"), so a
   * plain DOM node count could never tell 375px apart from 1440px — only
   * this kind of geometry check, done in a real browser, can.
   */
  async function visibleWeekColumns(page: Page): Promise<number> {
    const grid = page.getByRole('grid', { name: /Activity heatmap/ });
    return grid.evaluate((table) => {
      // table -> .rail -> .scroller (heatmap.module.css's structure).
      const scroller = table.parentElement!.parentElement as HTMLElement;
      const scrollerRect = scroller.getBoundingClientRect();
      const row = table.querySelector('tbody tr');
      if (!row) return 0;
      const EPS = 1; // px, for sub-pixel layout rounding
      let visible = 0;
      for (const cell of Array.from(row.querySelectorAll('td'))) {
        const r = cell.getBoundingClientRect();
        if (r.left >= scrollerRect.left - EPS && r.right <= scrollerRect.right + EPS) {
          visible += 1;
        }
      }
      return visible;
    });
  }

  test('genuinely shows more weeks without scrolling as the viewport widens', async ({ browser, baseURL }) => {
    await withAuthedPage(browser, baseURL, PHONE, async (page) => {
      await page.goto('/me');
      const phone = await visibleWeekColumns(page);

      await page.setViewportSize(TABLET);
      const tablet = await visibleWeekColumns(page);

      await page.setViewportSize(DESKTOP);
      const desktop = await visibleWeekColumns(page);

      // Design §10: "roughly 13 weeks on phone, 26 on tablet, 53 on
      // desktop" — a genuinely different column count at each width, not
      // one fixed count wearing three different cell sizes.
      expect(phone).toBeGreaterThanOrEqual(8);
      expect(tablet).toBeGreaterThan(phone);
      expect(desktop).toBeGreaterThan(tablet);
      expect(desktop).toBeGreaterThanOrEqual(45);
    });
  });

  test('the visible window matches HEATMAP_WINDOW_STEPS exactly — known bug, see comment', async ({
    browser,
    baseURL,
  }) => {
    // FOUND BUG, reported here rather than silently worked around:
    //
    // Measured in a real browser (Chromium, this harness), the number of
    // week columns that actually fit inside the heatmap's own scroll
    // viewport WITHOUT clipping falls short of what
    // `web/src/lib/heatmap.ts`'s HEATMAP_WINDOW_STEPS declares, at every
    // one of the three canonical widths:
    //
    //   375px:  11 columns fit, HEATMAP_WINDOW_STEPS says 13
    //   834px:  21 columns fit, HEATMAP_WINDOW_STEPS says 26
    //   1440px: 52 columns fit, HEATMAP_WINDOW_STEPS says 53
    //
    // Root cause: `heatmap.test.ts`'s "the window actually fits the
    // viewport it is for" describe block proves
    //   windowWidthPx(step) <= min(viewport, PAGE_MAX_WIDTH_PX) - 2 * step.gutterPx
    // but that formula is pure CSS-variable arithmetic — it never renders a
    // page, so it never subtracts:
    //   (a) the `.activity` card's own padding + border the heatmap
    //       actually sits inside (`web/app/me/me.module.css`: `.activity {
    //       padding: 1.25rem }` plus a 1px border, ~42px lost each side), or
    //   (b) at >=768px, the 180px in-flow nav sidebar
    //       (`web/app/_shell/nav.module.css`) — which starts taking space
    //       at exactly the same breakpoint the window widens to 26/53
    //       weeks, making the tablet case the worst of the three.
    //
    // That is precisely the class of defect Phase 15 task 3 exists for
    // (plan, Phase 15: "the check that would have caught what I could not
    // verify without a browser") — a CSS-only unit test proved the
    // arithmetic self-consistent while the real, composed page overflows.
    //
    // Not fixed here: task 3 is specs, and the real fix touches shared
    // geometry across heatmap.ts / heatmap.module.css / me.module.css (and
    // possibly the page-gutter/nav-width relationship generally), which is
    // beyond "add viewport specs." `test.fail()` keeps this red-for-a-real-
    // reason without failing CI: if the overflow gets fixed, this test
    // starts passing "unexpectedly" and THAT failure is the prompt to
    // delete this whole annotation.
    test.fail(true, 'Known bug: the heatmap window overflows its container at every canonical breakpoint.');

    await withAuthedPage(browser, baseURL, PHONE, async (page) => {
      await page.goto('/me');

      for (const step of HEATMAP_WINDOW_STEPS) {
        const width = Math.max(step.minViewportWidth, 375);
        const height =
          width === PHONE.width ? PHONE.height : width === TABLET.width ? TABLET.height : DESKTOP.height;
        await page.setViewportSize({ width, height });
        const visible = await visibleWeekColumns(page);
        expect(visible).toBe(visibleWeeksForWidth(width));
      }
    });
  });
});

test.describe('the lesson prose column holds its measure (design §14.1: "46ch")', () => {
  test('never exceeds its resolved 46ch max-width, which itself stays constant across breakpoints', async ({
    browser,
    baseURL,
  }) => {
    await withAuthedPage(browser, baseURL, PHONE, async (page) => {
      await page.goto(`/courses/${fixtures.courseSlug}/lessons/${fixtures.lessonSlug}`);

      const resolvedMeasures: number[] = [];
      for (const viewport of [PHONE, TABLET, DESKTOP]) {
        await page.setViewportSize(viewport);

        // The seeded lesson's closing prose block (tools/src/e2e-seed.ts)
        // — rendered inside `<div className={styles.prose}>` (lesson
        // page.tsx), the element `--measure-prose: 46ch` actually
        // constrains.
        const closingParagraph = page.getByText(/closing paragraph/);
        await expect(closingParagraph).toBeVisible();

        const metrics = await closingParagraph.evaluate((p) => {
          const prose = p.parentElement as HTMLElement;
          // getComputedStyle resolves `max-width: 46ch` against the real,
          // rendered font (Source Serif 4 per tokens.css) into an actual
          // px value — exactly the "measure it in the browser, not by
          // hand" the task calls for, since `ch` has no fixed px
          // conversion.
          const resolvedMaxWidthPx = Number.parseFloat(getComputedStyle(prose).maxWidth);
          const renderedWidthPx = prose.getBoundingClientRect().width;
          return { resolvedMaxWidthPx, renderedWidthPx };
        });

        expect(metrics.renderedWidthPx).toBeLessThanOrEqual(metrics.resolvedMaxWidthPx + 1);
        resolvedMeasures.push(metrics.resolvedMaxWidthPx);
      }

      // Design §14.2: "Prose measure stays constant across breakpoints" —
      // the resolved 46ch value itself must not move as the viewport
      // widens.
      for (const measure of resolvedMeasures) {
        expect(measure).toBeCloseTo(resolvedMeasures[0]!, 0);
      }

      // Sanity against design §14.1's own ballpark ("roughly 380–420px")
      // for the real font, not some unrelated cascade value.
      expect(resolvedMeasures[0]!).toBeGreaterThan(300);
      expect(resolvedMeasures[0]!).toBeLessThan(500);
    });
  });
});
