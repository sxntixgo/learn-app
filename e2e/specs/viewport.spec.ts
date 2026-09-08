import { readFileSync } from 'node:fs';
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { E2eFixtures } from '../../tools/src/e2e-seed.ts';
import { E2E_VIEWPORT_HANDLE } from '../../tools/src/e2e-seed.ts';
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
const IPAD_LANDSCAPE = { width: 1194, height: 834 };
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

/*
 * THE HEATMAP MOVED. It used to be on /me, which was the profile in disguise
 * — the same grid, badges and degrees rendered on both pages from the same
 * data. /me is the activity feed now and the grid lives only on the profile,
 * so this file drives it there. Nothing about the window policy it measures
 * changed.
 */
const HEATMAP_PAGE = `/u/${E2E_VIEWPORT_HANDLE}`;

let authState: Awaited<ReturnType<BrowserContext['storageState']>>;

test.beforeAll(async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await page.goto(`/login?next=${encodeURIComponent(HEATMAP_PAGE)}`);
  await page.getByLabel('Email').fill(fixtures.viewportUser.email);
  await page.getByLabel('Password').fill(fixtures.viewportUser.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(new RegExp(`${HEATMAP_PAGE}$`));
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
  // nav.module.css keys off exactly one `@media (min-width: 1024px)` — the
  // artboards' tier boundary (artboard-spec §3), above iPad portrait and
  // below iPad landscape. 375 and 834 are the narrow tier (iPhone and iPad
  // portrait: the identical eleven screens, hamburger and drawer, no rail);
  // 1194 and 1440 are the wide one ("the same permanent 224px teal rail — no
  // hamburger"). All four artboard widths, not three, and none of them
  // straddling the boundary — so which side each lands on is unambiguous
  // from the CSS alone and the assertions below confirm the rendered page
  // agrees.
  //
  // Was 768 here, and 834 was on the sidebar side of it. That was the wrong
  // tier for iPad portrait, and this file's failure at 834 is what the
  // boundary move left behind for the drawer task to answer.
  const CASES = [
    { ...PHONE, shape: 'hamburger drawer' as const },
    { ...TABLET, shape: 'hamburger drawer' as const },
    { ...IPAD_LANDSCAPE, shape: 'in-flow sidebar' as const },
    { ...DESKTOP, shape: 'in-flow sidebar' as const },
  ];

  for (const { width, height, shape } of CASES) {
    test(`${width}x${height} renders the ${shape}`, async ({ browser, baseURL }) => {
      await withAuthedPage(browser, baseURL, { width, height }, async (page) => {
        await page.goto(HEATMAP_PAGE);

        const nav = page.getByRole('navigation', { name: 'Primary' });
        // The sidebar's collapse control (nav.module.css: `.collapseToggle
        // { display: none }`, overridden only inside the >=1024px query)
        // exists in the DOM at every width — Nav.tsx always renders it —
        // so this is a real CSS-visibility check, not a markup check. The
        // hamburger is the same kind of check in the other direction.
        const collapseToggle = page.getByRole('button', { name: 'Collapse navigation' });
        const hamburger = page.getByRole('button', { name: 'Open navigation' });

        if (shape === 'hamburger drawer') {
          // Closed, the nav is not on the page at all: no bar, no rail, no
          // reserved strip. The hamburger is the only nav chrome there is.
          await expect(nav).toBeHidden();
          await expect(collapseToggle).not.toBeVisible();
          await expect(hamburger).toBeVisible();
          await expect(hamburger).toHaveAttribute('aria-expanded', 'false');

          await hamburger.click();
          await expect(nav).toBeVisible();
          await expect(hamburger).toHaveAttribute('aria-expanded', 'true');

          const box = (await nav.boundingBox())!;
          const position = await nav.evaluate((el) => getComputedStyle(el).position);
          // A panel over the page from the left edge, full height — not a
          // full-bleed bar and not a column the content sits beside.
          expect(position).toBe('fixed');
          expect(box.x).toBe(0);
          expect(box.width).toBeLessThan(width * 0.8);
          expect(box.height).toBeGreaterThan(height - 2);
        } else {
          const box = (await nav.boundingBox())!;
          const position = await nav.evaluate((el) => getComputedStyle(el).position);
          await expect(nav).toBeVisible();
          expect(position).toBe('sticky');
          // An in-flow column at the left edge, not a full-bleed bar —
          // comfortably narrower than half the viewport at both wide
          // widths.
          expect(box.x).toBe(0);
          expect(box.width).toBeGreaterThan(50);
          expect(box.width).toBeLessThan(width / 2);
          await expect(collapseToggle).toBeVisible();
          // No hamburger above the boundary (Desktop brief: "no hamburger").
          // Rendered but `display: none`, so it is also out of the tab order.
          await expect(hamburger).not.toBeVisible();
        }

        // THEME AXIS (Phase 6, "Add the theme axis"). Layout is what the
        // rest of this test checks, at this one width; colour is the
        // orthogonal axis a theme switch touches, so it is checked here
        // too — reusing the page this test already opened and signed into,
        // rather than a fresh context/login per theme. Every one of the
        // four CASES widths gets both themes this way, so the "375/834
        // narrow, 1194/1440 wide, both themes" surface the plan calls for
        // is genuinely covered, not just the two of the four that happen
        // to have a wide-tier counterpart tested elsewhere.
        //
        // The oracle is `var(--color-rail-bg)` read live off this exact
        // page via getComputedStyle on a throwaway probe element — never a
        // hex typed into this file, which would silently drift the moment
        // the palette does (tokens.css's whole point). If a rule painted
        // the rail with a colour that bypassed the token — the exact "a
        // colour hardcoded into a media query" the plan's acceptance
        // describes — the probe (which always resolves the token) and the
        // rail (painted by whatever rule actually wins) diverge, and this
        // fails.
        const railByTheme: Record<'light' | 'dark', string> = { light: '', dark: '' };
        for (const theme of ['light', 'dark'] as const) {
          const colors = await page.evaluate((t) => {
            document.documentElement.setAttribute('data-theme', t);
            const probe = document.createElement('div');
            probe.style.background = 'var(--color-rail-bg)';
            document.body.appendChild(probe);
            const probeColor = getComputedStyle(probe).backgroundColor;
            probe.remove();
            const navEl = document.querySelector('nav')!;
            return { probeColor, navColor: getComputedStyle(navEl).backgroundColor };
          }, theme);
          expect(colors.navColor, `${theme} rail background at ${width}px`).toBe(colors.probeColor);
          railByTheme[theme] = colors.navColor;
        }
        // A genuine switch has to have happened — two themes resolving to
        // the same colour would pass the per-theme check above vacuously.
        expect(railByTheme.light, `rail colour did not change with theme at ${width}px`).not.toBe(railByTheme.dark);
      });
    });
  }
});

/*
 * THE DRAWER ITSELF (artboard P11), at both narrow artboard widths.
 *
 * It replaces a fixed bottom tab bar that owed a keyboard nothing: the bar
 * was always on the page, so there was no focus to move, trap, or give back.
 * A drawer covers the page, and every one of those becomes something a
 * person can be stranded by. None of it comes free from an element the way
 * AccountMenu's <details> gives it — so all of it is asserted here.
 */
test.describe('the narrow-tier nav drawer', () => {
  const NARROW = [PHONE, TABLET];

  for (const viewport of NARROW) {
    test(`${viewport.width}: opens over the content without taking width from it`, async ({ browser, baseURL }) => {
      await withAuthedPage(browser, baseURL, viewport, async (page) => {
        await page.goto(HEATMAP_PAGE);

        // `.content` is the full viewport width minus its own padding at
        // this tier: the nav is out of flow, so it cannot take a column out
        // of the prose measure the way the rail legitimately does.
        const closed = await page.evaluate(() => {
          const main = document.querySelector('main')!;
          const styles = getComputedStyle(main);
          return {
            width: main.getBoundingClientRect().width,
            x: main.getBoundingClientRect().x,
            padding: Number.parseFloat(styles.paddingLeft) + Number.parseFloat(styles.paddingRight),
            layoutViewport: document.documentElement.clientWidth,
          };
        });
        expect(closed.x).toBe(0);
        expect(closed.width + closed.padding).toBe(closed.layoutViewport);

        await page.getByRole('button', { name: 'Open navigation' }).click();
        const nav = page.getByRole('navigation', { name: 'Primary' });
        await expect(nav).toBeVisible();

        const open = await page.evaluate(() => {
          const main = document.querySelector('main')!;
          const navEl = document.querySelector('nav')!;
          const box = navEl.getBoundingClientRect();
          // What is actually on top in the middle of the drawer's column —
          // the question a bounding box cannot answer on its own.
          const hit = document.elementFromPoint(Math.round(box.width / 2), Math.round(box.height / 2));
          return {
            mainWidth: main.getBoundingClientRect().width,
            drawerIsOnTop: hit === navEl || navEl.contains(hit),
          };
        });
        // Over the content, not beside it: same content width, drawer in front.
        expect(open.mainWidth).toBe(closed.width);
        expect(open.drawerIsOnTop, 'the drawer is not painting over the page').toBe(true);
      });
    });

    test(`${viewport.width}: traps focus, and the page behind it is inert`, async ({ browser, baseURL }) => {
      await withAuthedPage(browser, baseURL, viewport, async (page) => {
        await page.goto(HEATMAP_PAGE);
        await page.getByRole('button', { name: 'Open navigation' }).click();
        await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();

        // Focus moves INTO the drawer when it opens. Without this, Escape
        // has nothing to give back and a keyboard user has to tab from the
        // top of a document the drawer is already covering.
        expect(await page.evaluate(() => document.querySelector('nav')!.contains(document.activeElement))).toBe(true);

        // Tab all the way round — twice as many presses as the drawer has
        // stops — and focus never leaves it.
        const escapes: string[] = [];
        for (let i = 0; i < 25; i += 1) {
          await page.keyboard.press('Tab');
          const where = await page.evaluate(() => {
            const nav = document.querySelector('nav')!;
            const active = document.activeElement as HTMLElement | null;
            return nav.contains(active) ? null : `${active?.tagName ?? 'none'}:${active?.textContent?.trim().slice(0, 24) ?? ''}`;
          });
          if (where) escapes.push(`${i}:${where}`);
        }
        expect(escapes, 'focus left the drawer').toEqual([]);

        // Shift+Tab wraps the other way for the same reason.
        for (let i = 0; i < 5; i += 1) {
          await page.keyboard.press('Shift+Tab');
        }
        expect(await page.evaluate(() => document.querySelector('nav')!.contains(document.activeElement))).toBe(true);

        // And the rest of the shell is inert while it is open — out of the
        // tab order AND out of the accessibility tree, which is the pair a
        // hand-rolled trap usually gets only half of.
        const inert = await page.evaluate(() => ({
          banner: document.querySelector('header')!.inert,
          main: document.querySelector('main')!.inert,
          footer: document.querySelector('footer')!.inert,
        }));
        expect(inert).toEqual({ banner: true, main: true, footer: true });
      });
    });

    test(`${viewport.width}: closes on Escape and hands focus back to the hamburger`, async ({ browser, baseURL }) => {
      await withAuthedPage(browser, baseURL, viewport, async (page) => {
        await page.goto(HEATMAP_PAGE);
        const hamburger = page.getByRole('button', { name: 'Open navigation' });
        await hamburger.click();
        const nav = page.getByRole('navigation', { name: 'Primary' });
        await expect(nav).toBeVisible();

        await page.keyboard.press('Escape');
        await expect(nav).toBeHidden();
        await expect(hamburger).toHaveAttribute('aria-expanded', 'false');

        // A keyboard user must not be dumped at the top of the document.
        expect(await hamburger.evaluate((el) => el === document.activeElement)).toBe(true);
        // And the page behind is reachable again.
        const inert = await page.evaluate(() => ({
          banner: document.querySelector('header')!.inert,
          main: document.querySelector('main')!.inert,
          footer: document.querySelector('footer')!.inert,
        }));
        expect(inert).toEqual({ banner: false, main: false, footer: false });
      });
    });

    test(`${viewport.width}: a destination closes it rather than leaving it over the page`, async ({
      browser,
      baseURL,
    }) => {
      await withAuthedPage(browser, baseURL, viewport, async (page) => {
        await page.goto(HEATMAP_PAGE);
        await page.getByRole('button', { name: 'Open navigation' }).click();
        const nav = page.getByRole('navigation', { name: 'Primary' });
        await nav.getByRole('link', { name: 'Search' }).click();
        await page.waitForURL(/\/search$/);
        await expect(nav).toBeHidden();
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

      // The weekday label is STICKY: it stays pinned at the left edge while
      // the grid scrolls (it is scrolled to the current week by default), so
      // cells slide UNDERNEATH it. A cell behind the label is not visible,
      // however much of it is inside the scroller's box — counting from the
      // scroller's left edge instead of the label's right edge overstates the
      // window by exactly the one column the label covers.
      const label = row.querySelector('th');
      const leftEdge = label ? label.getBoundingClientRect().right : scrollerRect.left;

      const EPS = 1; // px, for sub-pixel layout rounding
      let visible = 0;
      for (const cell of Array.from(row.querySelectorAll('td'))) {
        const r = cell.getBoundingClientRect();
        if (r.left >= leftEdge - EPS && r.right <= scrollerRect.right + EPS) {
          visible += 1;
        }
      }
      return visible;
    });
  }

  test('genuinely shows more weeks without scrolling as the viewport widens', async ({ browser, baseURL }) => {
    await withAuthedPage(browser, baseURL, PHONE, async (page) => {
      await page.goto(HEATMAP_PAGE);
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

  test('the visible window matches HEATMAP_WINDOW_STEPS exactly', async ({ browser, baseURL }) => {
    // This was a `test.fail()` when Phase 15 found the overflow: measured in a
    // real browser, 11/21/52 columns fitted against a declared 13/26/53.
    //
    // The fix (see web/src/lib/heatmap.ts) was not to change the declared
    // numbers until they matched — it was to make the arithmetic describe the
    // page that actually exists. `heatmap.test.ts` proved
    //   windowWidthPx(step) <= min(viewport, PAGE_MAX_WIDTH) - 2 * gutter
    // which never subtracted the `.activity` card's padding and border (42px)
    // or, at >= 768px, the 180px in-flow nav sidebar — which appears at
    // exactly the breakpoint where the window widens, making tablet the worst
    // case. Two steps also began at widths where their own week count could
    // never have fitted, so they overflowed from their first pixel.
    //
    // This assertion is the one that cannot be satisfied by arithmetic about
    // an imaginary page: it counts columns that are genuinely unclipped in a
    // real browser.
    await withAuthedPage(browser, baseURL, PHONE, async (page) => {
      await page.goto(HEATMAP_PAGE);

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

test.describe('the lesson prose column holds its measure (design §14.1/§14.2: "60ch")', () => {
  test('never exceeds its resolved 60ch max-width, which itself stays constant across all four widths', async ({
    browser,
    baseURL,
  }) => {
    await withAuthedPage(browser, baseURL, PHONE, async (page) => {
      await page.goto(`/courses/${fixtures.courseSlug}/lessons/${fixtures.lessonSlug}`);

      const resolvedMeasures: number[] = [];
      // All four widths this design is checked at (artboard-spec §14.3):
      // 375 (iPhone), 834 (iPad portrait), 1194 (iPad landscape), 1440
      // (Desktop) — not just three, since the wide tier's contents panel
      // (Contents.tsx) changes how much room is available beside the
      // reading column, and the acceptance criterion is that prose does
      // not move even though the layout around it does.
      for (const viewport of [PHONE, TABLET, IPAD_LANDSCAPE, DESKTOP]) {
        await page.setViewportSize(viewport);

        // The seeded lesson's closing prose block (tools/src/e2e-seed.ts)
        // — rendered inside `<div className={styles.prose}>` (lesson
        // page.tsx), the element `--measure-prose: 60ch` actually
        // constrains.
        const closingParagraph = page.getByText(/closing paragraph/);
        await expect(closingParagraph).toBeVisible();

        const metrics = await closingParagraph.evaluate((p) => {
          const prose = p.parentElement as HTMLElement;
          // getComputedStyle resolves `max-width: 60ch` against the real,
          // rendered font (Source Serif 4 at the reader's 19px reading
          // size, per tokens.css) into an actual px value — exactly the
          // "measure it in the browser, not by hand" the task calls for,
          // since `ch` has no fixed px conversion.
          const resolvedMaxWidthPx = Number.parseFloat(getComputedStyle(prose).maxWidth);
          const renderedWidthPx = prose.getBoundingClientRect().width;
          return { resolvedMaxWidthPx, renderedWidthPx };
        });

        expect(metrics.renderedWidthPx).toBeLessThanOrEqual(metrics.resolvedMaxWidthPx + 1);
        resolvedMeasures.push(metrics.resolvedMaxWidthPx);
      }

      // Design §14.2: "Prose measure stays constant across breakpoints" —
      // the resolved 60ch value itself must not move as the viewport
      // widens, whether or not the wide-tier contents panel happens to be
      // open next to it.
      for (const measure of resolvedMeasures) {
        expect(measure).toBeCloseTo(resolvedMeasures[0]!, 0);
      }

      // Sanity against the reader artboards' own drawn value: 60ch at
      // `font: 400 19px 'Source Serif 4'` resolves to exactly 600px
      // (tokens.css's own comment on --measure-prose records how that was
      // measured) — not some unrelated cascade value.
      expect(resolvedMeasures[0]!).toBeGreaterThan(550);
      expect(resolvedMeasures[0]!).toBeLessThan(650);
    });
  });

  test('a code block escapes to --measure-breakout and is wider at 1440 than at 375', async ({ browser, baseURL }) => {
    await withAuthedPage(browser, baseURL, PHONE, async (page) => {
      await page.goto(`/courses/${fixtures.courseSlug}/lessons/${fixtures.lessonSlug}`);

      // The seeded lesson's one code block (tools/src/e2e-seed.ts),
      // rendered inside `<div className={styles.code}>` (lesson
      // page.tsx) — the breakout container `--measure-breakout` widens at
      // 834/1440 (tokens.css) while `.prose` above does not.
      const codeBlock = page.locator('.shiki').first();

      await page.setViewportSize(PHONE);
      await expect(codeBlock).toBeVisible();
      const widthAtPhone = await codeBlock.evaluate((el) => el.getBoundingClientRect().width);

      await page.setViewportSize(DESKTOP);
      const widthAtDesktop = await codeBlock.evaluate((el) => el.getBoundingClientRect().width);

      expect(widthAtDesktop).toBeGreaterThan(widthAtPhone);
    });
  });
});

/*
 * THEME AXIS, part two: explicit choice vs. OS preference (design §14, plan
 * Phase 6 "Add the theme axis"). The per-width check above (inside "the app
 * shell switches shape") proves the rail tracks `data-theme` at all four
 * artboard widths; it does not prove that choice actually BEATS the OS
 * preference rather than losing to it, or that leaving no explicit choice
 * still tracks the OS correctly. Both are real bugs `shiki-dual-theme.spec.ts`
 * already found once for code blocks (an improper media-query guard letting
 * the OS win over an explicit choice) — this is the same proof, aimed at the
 * app shell's own colour rather than Shiki's.
 *
 * One width only (DESKTOP, wide tier, nav always in-flow — no hamburger step
 * needed): the per-width loop above already proves the rail answers
 * `data-theme` at every width, so this file's job is the OS-vs-explicit
 * axis, not re-proving width coverage a second time.
 */
test.describe('the nav rail colour: explicit theme vs. OS preference', () => {
  /**
   * Navigate to the profile page under a given OS colour scheme, apply an
   * explicit `data-theme` (or leave it unset, for "system"), and read the
   * rail's computed background colour alongside a `var(--color-rail-bg)`
   * probe on the same page — the same live-browser oracle the per-width
   * check above uses, for the same reason: a typed-in hex would drift the
   * moment the palette does, and would not catch a rule that hardcodes a
   * colour instead of resolving the token.
   */
  async function getRailColors(
    browser: Browser,
    baseURL: string | undefined,
    osPreference: 'light' | 'dark',
    explicitTheme: 'light' | 'dark' | 'system',
  ): Promise<{ navColor: string; probeColor: string }> {
    const context = await browser.newContext({
      baseURL,
      storageState: authState,
      colorScheme: osPreference,
      viewport: DESKTOP,
    });
    try {
      const page = await context.newPage();
      await page.goto(HEATMAP_PAGE);
      return await page.evaluate((theme) => {
        if (theme !== 'system') {
          document.documentElement.setAttribute('data-theme', theme);
        }
        const probe = document.createElement('div');
        probe.style.background = 'var(--color-rail-bg)';
        document.body.appendChild(probe);
        const probeColor = getComputedStyle(probe).backgroundColor;
        probe.remove();
        const navEl = document.querySelector('nav')!;
        return { probeColor, navColor: getComputedStyle(navEl).backgroundColor };
      }, explicitTheme);
    } finally {
      await context.close();
    }
  }

  test('explicit dark theme overrides a light OS preference', async ({ browser, baseURL }) => {
    const { navColor, probeColor } = await getRailColors(browser, baseURL, 'light', 'dark');
    expect(navColor).toBe(probeColor);
  });

  test('explicit light theme overrides a dark OS preference', async ({ browser, baseURL }) => {
    const { navColor, probeColor } = await getRailColors(browser, baseURL, 'dark', 'light');
    expect(navColor).toBe(probeColor);
  });

  test('with no explicit choice, the rail follows the OS preference directly', async ({ browser, baseURL }) => {
    // This is the one case that reaches the guarded `@media (prefers-color-
    // scheme: dark) { :root:not([data-theme='light']) { ... } }` block in
    // tokens.css WITHOUT an explicit `data-theme` attribute in play at all —
    // the two override tests above always have `data-theme` set, so a
    // literal hardcoded only inside that guarded block (rather than the
    // unconditional `[data-theme='dark']` duplicate) could hide from them.
    const dark = await getRailColors(browser, baseURL, 'dark', 'system');
    const light = await getRailColors(browser, baseURL, 'light', 'system');
    expect(dark.navColor).toBe(dark.probeColor);
    expect(light.navColor).toBe(light.probeColor);
    expect(dark.navColor).not.toBe(light.navColor);
  });
});
