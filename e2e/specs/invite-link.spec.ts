import { readFileSync } from 'node:fs';
import { test, expect, type Browser, type Page } from '@playwright/test';
import type { E2eFixtures } from '../../tools/src/e2e-seed.ts';

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
 */
const fixtures: E2eFixtures = JSON.parse(readFileSync(new URL('../.fixtures.json', import.meta.url), 'utf8'));

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
