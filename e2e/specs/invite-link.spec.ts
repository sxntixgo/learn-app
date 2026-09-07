import { readFileSync } from 'node:fs';
import { test, expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import type { E2eFixtures } from '../../tools/src/e2e-seed.ts';
import { NAV_SIDEBAR_FROM_PX } from '../../web/src/lib/heatmap.ts';

/*
 * AN INVITE LINK IS SPENT BY BEING OPENED.
 *
 * The token in an invite URL is the credential (§13: "registration only via
 * invite token"), and a URL is the worst place to keep one — the reverse
 * proxy access-logs the path, the browser keeps it in history, and it rides
 * along in Referer. api/src/log-redaction.ts took the API's own log out of
 * that list; the proxy in front of it still records `GET /invite/<token>`.
 *
 * So opening the link consumes it (db/migrations/0020) and exchanges it for a
 * short-lived claim in an httpOnly cookie. A token recovered from a log
 * afterwards opens nothing.
 *
 * The API side is covered by api/src/routes/invites.test.ts. What only a
 * browser shows is the part that is spread across a route handler, a
 * redirect, a cookie and a server action:
 *
 *   - the token is GONE from the address bar after the first hop, so it never
 *     reaches history or a Referer;
 *   - a reload still works, because the claim cookie carries the invitation;
 *   - the same link in a FRESH browser is dead, which is the whole feature;
 *   - and the flow still ends in a registered, signed-in account.
 *
 * Serial, and against its own seeded invite: this spec spends a single-use
 * fixture, and Playwright runs files in parallel.
 *
 * ---------------------------------------------------------------------
 * Design-import plan, Phase 5: "Invitations + invite accept"
 * (`invites.module.css`, `accept.module.css`). Acceptance: "invite-link
 * .spec.ts green at four widths." NEITHER ROUTE HAS AN ARTBOARD (artboard
 * spec: "Routes with no artboard ... not per-screen tasks", naming
 * `/invites` and `/invite/[token]` explicitly), so the widths below check
 * the app's own two-tier system, not a mockup. Same measured technique as
 * grading.spec.ts/search.spec.ts/course.spec.ts: `boundingBox()` in a real
 * browser (`toBeVisible()` alone passes a layout a mis-specified flex/grid
 * rule has collapsed) plus `scrollWidth` for horizontal overflow, and the
 * tier read from `NAV_SIDEBAR_FROM_PX`, never a typed width literal.
 *
 * Three widths, three fixtures, chosen to add NO new seed data (tools/src/
 * e2e-seed.ts's append-only/no-cascade traps are exactly why):
 *   - the admin invitations LIST reuses `adminUser` (already used by
 *     a11y.spec.ts to reach the same page) — it always has at least
 *     `a11yInvite` on it, which nothing ever consumes.
 *   - the accept page's DEAD state needs no fixture at all: any signed-out
 *     visit to /invite with no claim cookie shows it, repeatably.
 *   - the accept page's INVITED (form) state reuses the storageState this
 *     file's own first test already produces by opening `burnInvite`'s
 *     link once — captured below rather than opened a second time, because
 *     the link is single-use FOREVER ("ALREADY OPENED" is its own dead
 *     reason in web/app/invite/[token]/route.ts). A reload of `/invite`
 *     does not consume anything further (the existing "a reload still
 *     works" step already proves this), so replaying that storageState
 *     across four viewport sizes is safe.
 * ---------------------------------------------------------------------
 */
const fixtures: E2eFixtures = JSON.parse(readFileSync(new URL('../.fixtures.json', import.meta.url), 'utf8'));

const WIDTHS = [
  { name: 'iPhone', width: 375, height: 812 },
  { name: 'iPad portrait', width: 834, height: 1194 },
  { name: 'iPad landscape', width: 1194, height: 834 },
  { name: 'Desktop', width: 1440, height: 900 },
] as const;

test.describe.configure({ mode: 'serial' });

async function withPage<T>(browser: Browser, run: (page: Page) => Promise<T>): Promise<T> {
  // A fresh context per call is the point, not hygiene: it is what makes
  // "the link is dead for the next visitor" a real question rather than one
  // answered by a cookie left over from the previous step.
  const context = await browser.newContext();
  try {
    return await run(await context.newPage());
  } finally {
    await context.close();
  }
}

/**
 * "Present" means it occupies pixels, not that it is in the DOM — a
 * collapsed flex/grid item passes `toBeVisible()` just fine. Same helper as
 * grading.spec.ts/search.spec.ts/course.spec.ts.
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

async function expectNoHorizontalScroll(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `${label} scrolls horizontally`).toBeLessThanOrEqual(1);
}

/** Captured once the first test below opens `burnInvite`'s link — see the header comment. */
let invitedState: Awaited<ReturnType<BrowserContext['storageState']>> | null = null;

test('opening an invite link spends it, and the rest of the flow rides a cookie', async ({ browser }) => {
  const { acceptPath, email } = fixtures.burnInvite;

  await withPage(browser, async (page) => {
    await test.step('the link opens, and the token leaves the URL', async () => {
      await page.goto(acceptPath);

      // The address bar is the assertion. Everything downstream of this — the
      // browser's history entry, the Referer on the form POST, the proxy's
      // access log for every subsequent request — sees only this.
      await expect(page).toHaveURL(/\/invite$/);
      expect(page.url(), 'the token survived into the URL').not.toContain(fixtures.burnInvite.token);

      await expect(page.getByRole('heading', { name: 'You are invited' })).toBeVisible();
      await expect(page.getByText(email)).toBeVisible();
    });

    await test.step('a reload still works, because the claim cookie carries it', async () => {
      // The link is already spent by now, so this only passes if the cookie
      // is doing the work.
      await page.reload();
      await expect(page).toHaveURL(/\/invite$/);
      await expect(page.getByRole('heading', { name: 'You are invited' })).toBeVisible();
    });

    await test.step('the claim cookie is httpOnly and scoped to /invite', async () => {
      const cookie = (await page.context().cookies()).find((c) => c.name === 'learn_invite');
      expect(cookie, 'no claim cookie was set').toBeDefined();
      // httpOnly is what keeps the credential out of reach of any script on
      // the page — the reason it is a cookie and not a hidden form field.
      expect(cookie?.httpOnly).toBe(true);
      expect(cookie?.path).toBe('/invite');
    });

    // Captured here, not opened again: the link is already spent, so this is
    // the ONLY moment anything can ride this particular claim cookie. The
    // "invited state at four widths" tests below replay it into fresh
    // contexts rather than following the link a second time.
    invitedState = await page.context().storageState();
  });

  await test.step('THE SAME LINK IS DEAD in a fresh browser', async () => {
    // A fresh context has no claim cookie, so this is exactly the position of
    // someone who found the URL in a log afterwards.
    await withPage(browser, async (page) => {
      await page.goto(acceptPath);
      await expect(page).toHaveURL(/\/invite$/);
      await expect(page.getByRole('heading', { name: 'This invitation is not valid' })).toBeVisible();
    });
  });
});

test('arriving at /invite with no claim shows the same dead page, revealing nothing', async ({ browser }) => {
  // A caller who never had a link and one whose link is spent must not be
  // able to tell themselves apart — the API answers 410 for every flavour of
  // dead with one message, and the page must not narrow it either.
  await withPage(browser, async (page) => {
    await page.goto('/invite');
    await expect(page.getByRole('heading', { name: 'This invitation is not valid' })).toBeVisible();
  });
});

/*
 * Layout coverage below. Functional correctness (the flow, the cookie, the
 * single-use guarantee) is proven above; these tests only check that
 * invites.module.css / accept.module.css render every element and never
 * force horizontal page scroll, at the four widths this app is built for.
 */

function tierOf(width: number): 'narrow' | 'wide' {
  return width >= NAV_SIDEBAR_FROM_PX ? 'wide' : 'narrow';
}

test.describe('accept page — dead state at four widths', () => {
  // No fixture involved: any signed-out visit to /invite with no claim
  // cookie shows this, and showing it again never consumes anything.
  for (const { name, width, height } of WIDTHS) {
    test(`renders with no horizontal scroll at ${width} (${name})`, async ({ browser, baseURL }) => {
      const context = await browser.newContext({ baseURL, viewport: { width, height } });
      try {
        const page = await context.newPage();
        await page.goto('/invite');
        await expectRendered(
          page.getByRole('heading', { name: 'This invitation is not valid' }),
          'the dead-invite heading',
        );
        await expectNoHorizontalScroll(page, `/invite (dead state) at ${width}`);
      } finally {
        await context.close();
      }
    });
  }
});

test.describe('accept page — invited state at four widths', () => {
  // Reuses the storageState captured when the first test in this file opened
  // burnInvite's link — see the file header comment on why this replays
  // rather than opening the link again.
  for (const { name, width, height } of WIDTHS) {
    test(`the registration form renders with no horizontal scroll at ${width} (${name})`, async ({
      browser,
      baseURL,
    }) => {
      expect(invitedState, 'burnInvite was never opened by the earlier test').not.toBeNull();
      const context = await browser.newContext({ baseURL, storageState: invitedState!, viewport: { width, height } });
      try {
        const page = await context.newPage();
        await page.goto('/invite');
        await expectRendered(page.getByRole('heading', { name: 'You are invited' }), 'the "you are invited" heading');
        await expectRendered(page.getByLabel('Handle'), 'the handle field');
        await expectRendered(page.getByLabel('Password', { exact: true }), 'the password field');
        await expectRendered(
          page.getByRole('button', { name: /Create account/ }),
          'the create-account submit button',
        );
        await expectNoHorizontalScroll(page, `/invite (invited state) at ${width}`);
      } finally {
        await context.close();
      }
    });
  }
});

test.describe('admin invitations list — width coverage', () => {
  // adminUser (fixtures.adminUser) is the same session a11y.spec.ts already
  // uses to reach /invites; it always has at least `a11yInvite` on its list,
  // since nothing ever accepts, revokes, or expires that fixture.
  let adminState: Awaited<ReturnType<BrowserContext['storageState']>>;

  test.beforeAll(async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    await page.goto(`/login?next=${encodeURIComponent('/invites')}`);
    await page.getByLabel('Email').fill(fixtures.adminUser.email);
    await page.getByLabel('Password').fill(fixtures.adminUser.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(/\/invites$/);
    adminState = await context.storageState();
    await context.close();
  });

  for (const { name, width, height } of WIDTHS) {
    const tier = tierOf(width);

    test(`renders every invitation row with no horizontal scroll at ${width} (${name}, ${tier} tier)`, async ({
      browser,
      baseURL,
    }) => {
      const context = await browser.newContext({ baseURL, storageState: adminState, viewport: { width, height } });
      try {
        const page = await context.newPage();
        await page.goto('/invites');

        await expectRendered(page.getByRole('heading', { name: 'Invitations', level: 1 }), 'the page heading');

        // The card list, not a <table> — see invites.module.css's header
        // comment (item 1) for why "what does a wide table do at 375" is
        // answered by never building one. `<ul>/<li>` gets the implicit
        // list/listitem roles used here.
        const rows = page.getByRole('listitem');
        const rowCount = await rows.count();
        expect(rowCount, 'the admin invitations list rendered no rows').toBeGreaterThan(0);

        // SAMPLED, NOT EXHAUSTIVE — deliberately. `/invites` is SHARED,
        // ACCUMULATING state: every spec that issues an invitation adds a row
        // that nothing removes, so `rowCount` is however many the rest of the
        // suite happened to create before this test ran. Checking each row's
        // box individually therefore costs a different amount on every run,
        // and in a full-suite run it blew this test's 30s budget while passing
        // in isolation at 15s — a flake whose cause is the assertion, not the
        // page. A fixed sample bounds the cost, and the per-row claim is about
        // the row TEMPLATE, which is identical for every row; the page-level
        // guarantee is `expectNoHorizontalScroll` below, which is unaffected
        // by row count.
        const sampled = Math.min(rowCount, 5);
        for (let i = 0; i < sampled; i += 1) {
          await expectRendered(rows.nth(i), `invitation row ${i}`);
        }

        await expectNoHorizontalScroll(page, `/invites at ${width}`);
      } finally {
        await context.close();
      }
    });
  }
});
