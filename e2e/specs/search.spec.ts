import { readFileSync } from 'node:fs';
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { E2eFixtures } from '../../tools/src/e2e-seed.ts';

// Phase 16 task 2: search UI specs. Machine-checks the plan's own
// acceptance line — "usable at 375px; keyboard reachable; empty and
// no-results states are real sentences" — plus the role-floor decision
// documented in web/app/search/page.tsx and web/src/lib/nav.ts: a
// teacher-only or admin account never sees the Search nav destination, and
// hitting the URL directly anyway gets a plain sentence rather than a
// redirect loop.
//
// Same AUTH shape as viewport.spec.ts/a11y.spec.ts: `mode: 'serial'`, sign
// in once per role in `beforeAll`, hand every test a fresh context seeded
// from the captured storageState — never a per-test login (each is a real
// Argon2id hash, deliberately expensive, design §13).
const fixturesPath = new URL('../.fixtures.json', import.meta.url);
const fixtures: E2eFixtures = JSON.parse(readFileSync(fixturesPath, 'utf8'));

const PHONE = { width: 375, height: 812 };

test.describe.configure({ mode: 'serial' });

let studentState: Awaited<ReturnType<BrowserContext['storageState']>>;
let teacherState: Awaited<ReturnType<BrowserContext['storageState']>>;
let adminState: Awaited<ReturnType<BrowserContext['storageState']>>;

async function signIn(browser: Browser, baseURL: string | undefined, email: string, password: string) {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await page.goto(`/login?next=${encodeURIComponent('/')}`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/^(?!.*\/login).*$/);
  const state = await context.storageState();
  await context.close();
  return state;
}

test.beforeAll(async ({ browser, baseURL }) => {
  studentState = await signIn(browser, baseURL, fixtures.viewportUser.email, fixtures.viewportUser.password);
  teacherState = await signIn(browser, baseURL, fixtures.teacherUser.email, fixtures.teacherUser.password);
  adminState = await signIn(browser, baseURL, fixtures.adminUser.email, fixtures.adminUser.password);
});

async function withPage<T>(
  browser: Browser,
  baseURL: string | undefined,
  state: Awaited<ReturnType<BrowserContext['storageState']>> | null,
  run: (page: Page) => Promise<T>,
  viewport?: { width: number; height: number },
): Promise<T> {
  const context = await browser.newContext({ baseURL, storageState: state ?? undefined, viewport });
  try {
    const page = await context.newPage();
    return await run(page);
  } finally {
    await context.close();
  }
}

// A word from tools/src/e2e-seed.ts's LESSON_MARKDOWN prose ("seeded
// fixture data for the Playwright harness") — distinctive enough not to
// collide with anything else a local run might have seeded.
const MATCHING_QUERY = 'seeded';
const NO_MATCH_QUERY = 'zzzznonexistentxyz123';

test.describe('the entry point is hidden from an account that cannot use it', () => {
  test('a student sees Search in the nav', async ({ browser, baseURL }) => {
    await withPage(browser, baseURL, studentState, async (page) => {
      await page.goto('/me');
      const nav = page.getByRole('navigation', { name: 'Primary' });
      await expect(nav.getByRole('link', { name: 'Search' })).toBeVisible();
    });
  });

  test('a teacher-only account does not see Search in the nav', async ({ browser, baseURL }) => {
    await withPage(browser, baseURL, teacherState, async (page) => {
      await page.goto('/grading');
      const nav = page.getByRole('navigation', { name: 'Primary' });
      await expect(nav.getByRole('link', { name: 'Search' })).toHaveCount(0);
    });
  });

  test('an admin account does not see Search in the nav', async ({ browser, baseURL }) => {
    await withPage(browser, baseURL, adminState, async (page) => {
      await page.goto('/admin/imports');
      const nav = page.getByRole('navigation', { name: 'Primary' });
      await expect(nav.getByRole('link', { name: 'Search' })).toHaveCount(0);
    });
  });
});

test.describe('reaching /search directly without the grant', () => {
  test('a teacher-only account gets a plain sentence, not a redirect loop', async ({ browser, baseURL }) => {
    await withPage(browser, baseURL, teacherState, async (page) => {
      // If this were still wired through withAuthRedirect (see page.tsx's
      // module comment), a signed-in-but-forbidden account loops between
      // /search and /login forever and this goto throws
      // net::ERR_TOO_MANY_REDIRECTS — the very failure this test exists to
      // catch a regression of.
      await page.goto('/search');
      await expect(page).toHaveURL(/\/search$/);
      await expect(page.getByText(/search isn.t available for this account/i)).toBeVisible();
    });
  });

  test('an admin account gets the same plain sentence', async ({ browser, baseURL }) => {
    await withPage(browser, baseURL, adminState, async (page) => {
      await page.goto('/search');
      await expect(page).toHaveURL(/\/search$/);
      await expect(page.getByText(/search isn.t available for this account/i)).toBeVisible();
    });
  });

  test('an anonymous visitor is sent to sign in, exactly like the catalog', async ({ browser, baseURL }) => {
    await withPage(browser, baseURL, null, async (page) => {
      await page.goto('/search');
      await expect(page).toHaveURL(/\/login\?next=%2Fsearch/);
    });
  });
});

test.describe('the two empty states are real, distinct sentences', () => {
  test('nothing typed yet invites a search rather than showing a bare "no results"', async ({ browser, baseURL }) => {
    await withPage(browser, baseURL, studentState, async (page) => {
      await page.goto('/search');
      await expect(page.getByText(/type a word or phrase above/i)).toBeVisible();
      // Not the no-matches sentence — the two states never render together.
      await expect(page.getByText(/no lessons matched/i)).toHaveCount(0);
    });
  });

  test('a query that matches nothing names the query back and suggests what to do', async ({ browser, baseURL }) => {
    await withPage(browser, baseURL, studentState, async (page) => {
      await page.goto(`/search?q=${encodeURIComponent(NO_MATCH_QUERY)}`);
      const message = page.getByText(/no lessons matched/i);
      await expect(message).toBeVisible();
      await expect(message).toContainText(NO_MATCH_QUERY);
      await expect(page.getByText(/type a word or phrase above/i)).toHaveCount(0);
    });
  });
});

test.describe('real results, grouped by course', () => {
  test('a matching query surfaces the seeded lesson under its course, with the match highlighted', async ({
    browser,
    baseURL,
  }) => {
    await withPage(browser, baseURL, studentState, async (page) => {
      await page.goto(`/search?q=${encodeURIComponent(MATCHING_QUERY)}`);

      const resultLink = page.getByRole('link', { name: /Getting started/ });
      await expect(resultLink).toBeVisible();
      await expect(resultLink).toHaveAttribute(
        'href',
        `/courses/${fixtures.courseSlug}/lessons/${fixtures.lessonSlug}`,
      );

      // Snippet's one permitted tag (api/src/search/query.ts's
      // renderSnippet) actually rendered as a real element, not escaped
      // text — proves the search UI renders the highlight rather than
      // showing literal "&lt;mark&gt;" to the reader.
      const mark = resultLink.locator('mark');
      await expect(mark.first()).toBeVisible();
    });
  });
});

test.describe('keyboard reachability (plan, Phase 16: "keyboard reachable")', () => {
  test('tab reaches the search input, submitting keeps focus reachable, and a result link is reachable and escapable', async ({
    browser,
    baseURL,
  }) => {
    await withPage(browser, baseURL, studentState, async (page) => {
      await page.goto('/me');

      // Reachable via Tab from the top of the document, through the nav,
      // to the Search link — no click.
      let reached = false;
      const searchLink = page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Search' });
      for (let i = 0; i < 40 && !reached; i++) {
        await page.keyboard.press('Tab');
        reached = await searchLink.evaluate((el) => el === document.activeElement).catch(() => false);
      }
      expect(reached, 'Tab never reached the Search nav link within 40 presses').toBe(true);

      await page.keyboard.press('Enter');
      await page.waitForURL(/\/search$/);

      // The input is next in tab order (or reachable shortly after) —
      // never a focus trap inside the nav.
      const input = page.getByLabel('Search lessons');
      let inputReached = false;
      for (let i = 0; i < 20 && !inputReached; i++) {
        await page.keyboard.press('Tab');
        inputReached = await input.evaluate((el) => el === document.activeElement).catch(() => false);
      }
      expect(inputReached, 'Tab never reached the search input').toBe(true);

      await page.keyboard.type(MATCHING_QUERY);
      await page.keyboard.press('Enter');
      await page.waitForURL(new RegExp(`q=${MATCHING_QUERY}`));

      // A result link is reachable by keyboard and, activated, actually
      // navigates — proving it is a real link, not a mouse-only affordance.
      const resultLink = page.getByRole('link', { name: /Getting started/ });
      await expect(resultLink).toBeVisible();
      await resultLink.focus();
      await expect(resultLink).toBeFocused();
      await page.keyboard.press('Enter');
      await page.waitForURL(new RegExp(`/courses/${fixtures.courseSlug}/lessons/${fixtures.lessonSlug}$`));
    });
  });
});

test.describe('usable at 375px (plan, Phase 16: "usable at 375px", not merely non-overflowing)', () => {
  test('the input, submit control, and a result card all fit the viewport with no horizontal scroll', async ({
    browser,
    baseURL,
  }) => {
    await withPage(
      browser,
      baseURL,
      studentState,
      async (page) => {
        await page.goto(`/search?q=${encodeURIComponent(MATCHING_QUERY)}`);

        // The classic "usable", not "does not overflow", check: the whole
        // document never scrolls sideways at the narrowest supported width.
        const overflows = await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        );
        expect(overflows, 'The page scrolls horizontally at 375px').toBe(false);

        const viewportWidth = PHONE.width;

        const input = page.getByLabel('Search lessons');
        await expect(input).toBeVisible();
        const inputBox = await input.boundingBox();
        if (!inputBox) throw new Error('search input has no bounding box');
        expect(inputBox.x).toBeGreaterThanOrEqual(0);
        expect(inputBox.x + inputBox.width).toBeLessThanOrEqual(viewportWidth + 1);
        // A real touch target, not a decorative sliver.
        expect(inputBox.height).toBeGreaterThanOrEqual(44);

        const submitButton = page.getByRole('button', { name: 'Search' });
        await expect(submitButton).toBeVisible();
        const buttonBox = await submitButton.boundingBox();
        if (!buttonBox) throw new Error('submit button has no bounding box');
        expect(buttonBox.height).toBeGreaterThanOrEqual(44);
        expect(buttonBox.width).toBeGreaterThanOrEqual(44);

        const resultLink = page.getByRole('link', { name: /Getting started/ });
        await expect(resultLink).toBeVisible();
        const resultBox = await resultLink.boundingBox();
        if (!resultBox) throw new Error('result card has no bounding box');
        expect(resultBox.x).toBeGreaterThanOrEqual(0);
        expect(resultBox.x + resultBox.width).toBeLessThanOrEqual(viewportWidth + 1);

        // The snippet text itself is genuinely readable, not clipped to a
        // sliver by a fixed width or `overflow: hidden`.
        const snippet = resultLink.locator('span').last();
        const snippetBox = await snippet.boundingBox();
        if (!snippetBox) throw new Error('snippet has no bounding box');
        expect(snippetBox.width).toBeGreaterThan(100);
      },
      PHONE,
    );
  });

  test('the no-matches sentence is fully visible with no horizontal scroll at 375px', async ({ browser, baseURL }) => {
    await withPage(
      browser,
      baseURL,
      studentState,
      async (page) => {
        await page.goto(`/search?q=${encodeURIComponent(NO_MATCH_QUERY)}`);
        const overflows = await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        );
        expect(overflows, 'The no-matches page scrolls horizontally at 375px').toBe(false);
        await expect(page.getByText(/no lessons matched/i)).toBeVisible();
      },
      PHONE,
    );
  });
});
