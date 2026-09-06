import { readFileSync } from 'node:fs';
import { test, expect, type Browser, type Page } from '@playwright/test';
import type { E2eFixtures } from '../../tools/src/e2e-seed.ts';

/*
 * THE WIDE-TIER CHROME: the 224px teal rail, and the one agreement it has
 * already broken once.
 *
 * `--banner-height` is declared in shell.module.css and consumed by three
 * rules that must agree about it — the banner's own `min-height`, the rail's
 * sticky `top`, and the rail's `height: calc(100dvh - ...)`. When they last
 * disagreed the rail stuck to the top of the viewport BEHIND the banner and
 * painted over it.
 *
 * WHY THIS FILE MEASURES INSTEAD OF READING THE CSS. All three rules quote
 * the same `var(--banner-height)`, so a check that read the stylesheet would
 * have said "they agree" throughout the bug. What actually matters is
 * whether the banner RENDERS at that height — `min-height` is a floor, and
 * one control taller than 4rem silently pushes the real banner past the
 * number the other two rules are still using. So every number below comes
 * from `getBoundingClientRect()` and `getComputedStyle()` in a real browser.
 *
 * 1194 and 1440 are the two wide artboards (iPad landscape, Desktop —
 * docs/design/2026-09-02-artboard-spec.md §3). They are one implementation,
 * so both are asserted rather than one being assumed to imply the other.
 */
const fixtures: E2eFixtures = JSON.parse(readFileSync(new URL('../.fixtures.json', import.meta.url), 'utf8'));

/** The wide artboards. Both, because the design says they are the same screen. */
const WIDE = [
  { width: 1194, height: 834, label: 'iPad landscape' },
  { width: 1440, height: 900, label: 'Desktop' },
] as const;

/** The rail's declared width, from `--rail-width` in shell.module.css. */
const RAIL_WIDTH = 224;

async function signIn(page: Page, email: string, password: string) {
  await page.goto(`/login?next=${encodeURIComponent('/')}`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/^(?!.*\/login).*$/);
}

async function wide<T>(
  browser: Browser,
  viewport: { width: number; height: number },
  credentials: { email: string; password: string },
  run: (page: Page) => Promise<T>,
): Promise<T> {
  const context = await browser.newContext({ viewport });
  try {
    const page = await context.newPage();
    await signIn(page, credentials.email, credentials.password);
    return await run(page);
  } finally {
    await context.close();
  }
}

test.describe('the wide-tier rail and the banner it hangs from', () => {
  for (const { width, height, label } of WIDE) {
    test(`${width}x${height} (${label}): the rail's sticky top IS the banner's rendered height`, async ({
      browser,
    }) => {
      await wide(browser, { width, height }, fixtures.viewportUser, async (page) => {
        const measured = await page.evaluate(() => {
          const banner = document.querySelector('header')!;
          const nav = document.querySelector('nav')!;
          return {
            bannerHeight: banner.getBoundingClientRect().height,
            // The resolved value of `top: var(--banner-height)`, in px, as
            // the browser computed it — not the declaration.
            navStickyTop: Number.parseFloat(getComputedStyle(nav).top),
            navPosition: getComputedStyle(nav).position,
            navHeight: nav.getBoundingClientRect().height,
            viewportHeight: window.innerHeight,
          };
        });

        // The rail is only sticky at all at this tier; if it were static the
        // rest of this test would be measuring nothing.
        expect(measured.navPosition).toBe('sticky');

        // RULE 1 vs RULE 2. Sub-pixel tolerance only: these are the same
        // number expressed twice, not two numbers that happen to be close.
        expect(
          Math.abs(measured.navStickyTop - measured.bannerHeight),
          `sticky top ${measured.navStickyTop} vs rendered banner ${measured.bannerHeight}`,
        ).toBeLessThanOrEqual(0.5);

        // RULE 3: the rail fills what the banner leaves, and no more. Taller
        // than this and the rail's own bottom (where the account control is
        // pinned) hangs below the fold at every scroll position.
        expect(
          Math.abs(measured.navHeight - (measured.viewportHeight - measured.bannerHeight)),
          `rail height ${measured.navHeight} vs viewport ${measured.viewportHeight} - banner ${measured.bannerHeight}`,
        ).toBeLessThanOrEqual(1);
      });
    });

    test(`${width}x${height} (${label}): scrolled, the rail parks under the banner rather than behind it`, async ({
      browser,
    }) => {
      // The behavioural half. The agreement above is arithmetic; this is the
      // symptom it exists to prevent, and it is what the numbers agreeing on
      // paper failed to catch last time.
      await wide(browser, { width, height }, fixtures.viewportUser, async (page) => {
        /*
         * THE PAGE IS MADE TALL ON PURPOSE, and this is not laziness about
         * fixtures. `position: sticky` only sticks while its containing
         * block still extends past the viewport; on a short page the rail
         * correctly slides up with the end of `.body`, and shell-layout.spec
         * .ts records a previous spec that failed in CI for exactly that
         * reason — the seeded catalog is shorter there than locally. A
         * spacer makes the scroll real at every width and in every
         * environment, so what is asserted below is the sticky rule rather
         * than the seed's height.
         */
        await page.evaluate(() => {
          const spacer = document.createElement('div');
          spacer.style.height = '3000px';
          document.querySelector('main')!.appendChild(spacer);
        });
        await page.evaluate(() => window.scrollTo(0, 400));
        await page.waitForTimeout(200);

        const stuck = await page.evaluate(() => {
          const banner = document.querySelector('header')!;
          const nav = document.querySelector('nav')!;
          const bannerBox = banner.getBoundingClientRect();
          const navBox = nav.getBoundingClientRect();
          // The one question the geometry cannot answer on its own: with the
          // two boxes touching, WHICH of them is the thing you see there.
          const hit = document.elementFromPoint(40, Math.round(bannerBox.top + bannerBox.height / 2));
          return {
            scrollY: window.scrollY,
            bannerBottom: bannerBox.bottom,
            bannerHeight: bannerBox.height,
            navTop: navBox.top,
            bannerIsOnTop: hit === banner || banner.contains(hit),
            navIsOnTop: hit === nav || nav.contains(hit),
          };
        });

        // The spacer did its job; without this the rest is vacuous.
        expect(stuck.scrollY).toBe(400);
        // Flush: the rail's top edge is the banner's bottom edge. A gap
        // means dead teal; an overlap is the painting-over bug.
        expect(Math.abs(stuck.navTop - stuck.bannerBottom)).toBeLessThanOrEqual(0.5);
        // And still measured against the SAME rendered banner height, so a
        // banner that grew is caught here too rather than only above.
        expect(Math.abs(stuck.navTop - stuck.bannerHeight)).toBeLessThanOrEqual(0.5);
        // Banner and rail are the same teal, so a rail painting over the
        // banner is invisible to the eye and to a screenshot. Ask the
        // browser which one is in front instead.
        expect(stuck.navIsOnTop, 'the rail is painting over the banner').toBe(false);
        expect(stuck.bannerIsOnTop).toBe(true);
      });
    });

    test(`${width}x${height} (${label}): the rail is the artboard's 224px teal column`, async ({ browser }) => {
      await wide(browser, { width, height }, fixtures.viewportUser, async (page) => {
        const rail = await page.evaluate(() => {
          const nav = document.querySelector('nav')!;
          const box = nav.getBoundingClientRect();
          const styles = getComputedStyle(nav);
          const root = document.querySelector('main')!.parentElement!.parentElement!;
          return {
            x: box.x,
            width: box.width,
            background: styles.backgroundColor,
            railToken: getComputedStyle(root).getPropertyValue('--color-rail-bg').trim(),
            widthToken: getComputedStyle(root).getPropertyValue('--rail-width').trim(),
          };
        });

        expect(rail.x).toBe(0);
        expect(rail.width).toBe(RAIL_WIDTH);
        // The declared token and the rendered column are the same number, so
        // the rail cannot be 224px by coincidence of some other rule.
        expect(rail.widthToken).toBe(`${RAIL_WIDTH}px`);
        // Teal from the token, not a colour of its own — the theme axis stays
        // free (the plan's rule: a @media block that sets a colour is a bug).
        expect(rail.background).not.toBe('rgba(0, 0, 0, 0)');
        expect(rail.railToken.length).toBeGreaterThan(0);
      });
    });

    test(`${width}x${height} (${label}): the account control is pinned at the bottom of the rail`, async ({
      browser,
    }) => {
      // Artboard M1 puts it below a `flex: 1` spacer, at the foot of the
      // rail. It used to live at the right of the banner; if the move ever
      // half-happens, this is what says so.
      await wide(browser, { width, height }, fixtures.viewportUser, async (page) => {
        const summary = page.locator('nav details > summary');
        await expect(summary).toBeVisible();

        const geometry = await page.evaluate(() => {
          const nav = document.querySelector('nav')!.getBoundingClientRect();
          const control = document.querySelector('nav details')!.getBoundingClientRect();
          const list = document.querySelector('nav ul')!.getBoundingClientRect();
          return { navBottom: nav.bottom, controlBottom: control.bottom, controlTop: control.top, listBottom: list.bottom };
        });

        // Below the destinations, and within a comfortable pad of the rail's
        // own bottom edge rather than following the list down the page.
        expect(geometry.controlTop).toBeGreaterThan(geometry.listBottom);
        expect(geometry.navBottom - geometry.controlBottom).toBeLessThan(60);
      });
    });
  }

  test('1440: the rail lists the enrolled courses with their progress', async ({ browser }) => {
    // A different fixture on purpose: `viewportUser` holds no enrollment, and
    // `feedUser` is the seeded student who is enrolled with nothing completed
    // (tools/src/e2e-seed.ts). The rail must list a course you have not
    // started — that is the difference between this list and the profile's,
    // which publishes only what is completed or in progress.
    await wide(browser, { width: 1440, height: 900 }, fixtures.feedUser, async (page) => {
      const courses = page.getByRole('list', { name: 'Enrolled courses' });
      await expect(courses).toBeVisible();
      await expect(courses.getByRole('link')).not.toHaveCount(0);

      // The percent is readable, not merely drawn: the bar is aria-hidden
      // decoration and the number is in the accessible name.
      const firstCourse = courses.getByRole('link').first();
      await expect(firstCourse).toContainText(/%\s*complete/);

      // And it is inside the rail, above the account control.
      const inRail = await firstCourse.evaluate((el) => el.closest('nav') !== null);
      expect(inRail).toBe(true);
    });
  });
});
