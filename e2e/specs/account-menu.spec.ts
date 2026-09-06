import { readFileSync } from 'node:fs';
import { test, expect, type Browser, type Page } from '@playwright/test';
import type { E2eFixtures } from '../../tools/src/e2e-seed.ts';

/*
 * The account menu — pinned to the bottom of the 224px rail at wide, and to
 * the bottom of the nav drawer at narrow (Shell.tsx: one AccountMenu node,
 * handed to Nav, at every width — never a per-tier copy).
 *
 * Built on <details>/<summary>, so most of what a menu needs — keyboard
 * operation, expanded state, focus order — comes from the element rather than
 * from code. These tests check the parts that do NOT come free: what is in
 * it, who sees which entries, that it dismisses, and — the point of this
 * file's rewrite — that all of that holds at EVERY artboard width, not just
 * whatever Playwright's default viewport happens to be.
 *
 * Below 1024px the menu lives inside the hamburger drawer, which is
 * `display: none` until opened (nav.module.css) — so every test opens the
 * drawer first at those widths. Above 1024px the rail is permanent and
 * there is no drawer to open.
 */
const fixtures: E2eFixtures = JSON.parse(readFileSync(new URL('../.fixtures.json', import.meta.url), 'utf8'));

/*
 * SERIAL, for the same reason viewport.spec.ts is: signing in for real goes
 * through Argon2id (deliberately expensive, design §13), and parametrizing
 * every test in this file across four widths turned 8 real logins into 32.
 * Left `fullyParallel`, that is 32 concurrent Argon2id hashes competing with
 * whatever else the full suite is running — reproduced here as a handful of
 * unrelated specs (viewport.spec.ts, a11y.spec.ts) timing out on a plain
 * `getByRole(...).toBeVisible()` under full-suite load, and passing cleanly
 * every time in isolation. Capping this file's own peak concurrency at one
 * worker doesn't fix flakiness elsewhere, but it stops this file from being
 * the thing that pushes the rest of the suite over the edge.
 */
test.describe.configure({ mode: 'serial' });

/** The four artboard widths (artboard-spec §3): narrow tier, then wide. */
const WIDTHS = [
  { width: 375, height: 812, label: 'iPhone' },
  { width: 834, height: 1194, label: 'iPad portrait' },
  { width: 1194, height: 834, label: 'iPad landscape' },
  { width: 1440, height: 900, label: 'Desktop' },
] as const;

/** 1024px is the shell's own tier boundary (nav.module.css's one documented home). */
function isNarrow(width: number): boolean {
  return width < 1024;
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto(`/login?next=${encodeURIComponent('/')}`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/^(?!.*\/login).*$/);
}

async function asStudent<T>(
  browser: Browser,
  viewport: { width: number; height: number },
  run: (page: Page) => Promise<T>,
): Promise<T> {
  const context = await browser.newContext({ viewport });
  try {
    const page = await context.newPage();
    await signIn(page, fixtures.viewportUser.email, fixtures.viewportUser.password);
    return await run(page);
  } finally {
    await context.close();
  }
}

/**
 * Below 1024px the menu is inside the drawer, and the drawer is `display:
 * none` until the hamburger opens it — so every narrow-tier interaction has
 * to open it first. A no-op at the wide tier, where the rail (and the menu
 * pinned to its bottom) is already in the page.
 */
async function openDrawerIfNarrow(page: Page, width: number) {
  if (isNarrow(width)) {
    await page.getByRole('button', { name: 'Open navigation' }).click();
  }
}

/**
 * "Click away" needs a different target per tier. At wide, the page's own
 * `<h1>` is a plain, unobstructed click. At narrow, while the drawer is
 * open, everything BUT the drawer is `inert` (Nav.tsx marks
 * `[data-drawer-inert]`) — an inert `<h1>` fails Playwright's actionability
 * check outright, and even if it didn't, the drawer's own scrim (rendered on
 * top, z-index 45) is what a real pointer user would actually hit first. So
 * at narrow this clicks a raw coordinate over the scrim: past the drawer's
 * own width (`min(77vw, 360px)`, nav.module.css), which is not part of the
 * `<details>` and not `inert`, so AccountMenu's own "click outside" listener
 * (AccountMenu.tsx's pointerdown handler) sees it as outside and closes.
 */
async function clickAway(page: Page, width: number) {
  if (isNarrow(width)) {
    const drawerWidth = Math.min(0.77 * width, 360);
    const x = Math.min(drawerWidth + 20, width - 5);
    await page.mouse.click(x, 100);
  } else {
    await page.locator('h1').first().click();
  }
}

for (const { width, height, label } of WIDTHS) {
  test.describe(`the account menu — ${label} (${width}px)`, () => {
    test('starts closed, and the name opens it', async ({ browser }) => {
      await asStudent(browser, { width, height }, async (page) => {
        await openDrawerIfNarrow(page, width);
        const menu = page.locator('details').first();

        // Closed on load: the panel must not be covering the page before
        // anyone asks for it.
        expect(await menu.evaluate((el: HTMLDetailsElement) => el.open)).toBe(false);
        await expect(page.getByRole('button', { name: 'Sign out' })).toBeHidden();

        await menu.locator('summary').click();
        expect(await menu.evaluate((el: HTMLDetailsElement) => el.open)).toBe(true);
      });
    });

    test('offers profile, settings, theme and sign out', async ({ browser }) => {
      await asStudent(browser, { width, height }, async (page) => {
        await openDrawerIfNarrow(page, width);
        await page.locator('details').first().locator('summary').click();

        await expect(page.getByRole('link', { name: 'Your profile' })).toBeVisible();
        await expect(page.getByRole('link', { name: 'Profile & visibility' })).toBeVisible();
        await expect(page.getByRole('link', { name: 'Account & password' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
        // The theme control moved in here from the banner.
        await expect(page.getByRole('button', { name: 'Dark' })).toBeVisible();
      });
    });

    test('“Your profile” goes to the public page, not the settings screen', async ({ browser }) => {
      // The reported gap: the profile existed but was reachable only from the
      // dashboard.
      await asStudent(browser, { width, height }, async (page) => {
        await openDrawerIfNarrow(page, width);
        await page.locator('details').first().locator('summary').click();
        await page.getByRole('link', { name: 'Your profile' }).click();
        await expect(page).toHaveURL(/\/u\/[a-z0-9-]+$/);
        await expect(page).not.toHaveURL(/no-access|login/);
      });
    });

    test('closes on Escape, and returns focus to the control', async ({ browser }) => {
      await asStudent(browser, { width, height }, async (page) => {
        await openDrawerIfNarrow(page, width);
        const menu = page.locator('details').first();
        await menu.locator('summary').click();
        expect(await menu.evaluate((el: HTMLDetailsElement) => el.open)).toBe(true);

        await page.keyboard.press('Escape');
        expect(await menu.evaluate((el: HTMLDetailsElement) => el.open)).toBe(false);
        // A keyboard user must not be dumped at the top of the document.
        expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('SUMMARY');
      });
    });

    test('closes when you click away from it', async ({ browser }) => {
      await asStudent(browser, { width, height }, async (page) => {
        await openDrawerIfNarrow(page, width);
        const menu = page.locator('details').first();
        await menu.locator('summary').click();
        expect(await menu.evaluate((el: HTMLDetailsElement) => el.open)).toBe(true);

        await clickAway(page, width);
        expect(await menu.evaluate((el: HTMLDetailsElement) => el.open)).toBe(false);
      });
    });

    test('is operable by keyboard alone', async ({ browser }) => {
      // The whole reason for <details>: none of this is implemented here.
      await asStudent(browser, { width, height }, async (page) => {
        await openDrawerIfNarrow(page, width);
        const menu = page.locator('details').first();
        await menu.locator('summary').focus();
        await page.keyboard.press('Enter');
        expect(await menu.evaluate((el: HTMLDetailsElement) => el.open)).toBe(true);

        await page.keyboard.press('Tab');
        const focused = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '');
        expect(focused.length, 'Tab should land on the first item in the panel').toBeGreaterThan(0);
      });
    });

    test('hides the learner entries from an operator account', async ({ browser }) => {
      // §5.1: operator accounts have no public profile, and /settings/profile is
      // student-only. Offering either would send an admin to /no-access.
      const context = await browser.newContext({ viewport: { width, height } });
      try {
        const page = await context.newPage();
        await signIn(page, fixtures.adminUser.email, fixtures.adminUser.password);
        await openDrawerIfNarrow(page, width);
        await page.locator('details').first().locator('summary').click();

        await expect(page.getByRole('link', { name: 'Your profile' })).toHaveCount(0);
        await expect(page.getByRole('link', { name: 'Profile & visibility' })).toHaveCount(0);
        // But the entries that work for everyone are still there.
        await expect(page.getByRole('link', { name: 'Account & password' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
      } finally {
        await context.close();
      }
    });

    test('signing out still works from inside the menu', async ({ browser }) => {
      await asStudent(browser, { width, height }, async (page) => {
        await openDrawerIfNarrow(page, width);
        await page.locator('details').first().locator('summary').click();
        await page.getByRole('button', { name: 'Sign out' }).click();
        await expect(page).toHaveURL(/\/login/);
      });
    });
  });
}
