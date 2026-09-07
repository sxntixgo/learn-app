import { readFileSync } from 'node:fs';
import { test, expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import type { E2eFixtures } from '../../tools/src/e2e-seed.ts';
import { NAV_SIDEBAR_FROM_PX } from '../../web/src/lib/heatmap.ts';

/*
 * Design-import plan, Phase 5: "Grading queue + grading view"
 * (`grading.module.css`, `grading-view.module.css`). Acceptance: "the split
 * grading view collapses per the artboard at narrow tier; no horizontal
 * page scroll at 375."
 *
 * NEITHER ROUTE HAS AN ARTBOARD. The artboard spec (§4) and this plan's own
 * Phase 0 outcome both list `/grading` and its submission route among the
 * nine routes with "no artboard — out of scope... not per-screen tasks".
 * So "collapses per the artboard" is read here as "per the app's own
 * two-tier system" (artboard-spec §3), and the split itself — a submission
 * column beside a rubric + return sidebar at 1024px+, stacked below it — is
 * this task's own design, documented in grading-view.module.css's header
 * comment, not a transcription. This file is the measured half of the
 * acceptance line, same technique as course.spec.ts/search.spec.ts:
 * `boundingBox()` in a real browser (a collapsed flex item passes
 * `toBeVisible()` just fine), and the tier is read from
 * `NAV_SIDEBAR_FROM_PX`, never a typed width literal.
 *
 * Sign in as `teacherUser` (tools/src/e2e-seed.ts), the fixture that owns
 * the seeded course and its one submitted exercise (`exerciseSubmission`).
 * Serial + one `beforeAll` login, the same reasoning course.spec.ts and
 * search.spec.ts give: concurrent Argon2id logins reproduced a flake in
 * another spec twice.
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

test.describe.configure({ mode: 'serial' });

let teacherState: Awaited<ReturnType<BrowserContext['storageState']>>;

test.beforeAll(async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await page.goto(`/login?next=${encodeURIComponent('/grading')}`);
  await page.getByLabel('Email').fill(fixtures.teacherUser.email);
  await page.getByLabel('Password').fill(fixtures.teacherUser.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/grading$/);
  teacherState = await context.storageState();
  await context.close();
});

async function withTeacher<T>(
  browser: Browser,
  baseURL: string | undefined,
  viewport: { width: number; height: number },
  path: string,
  run: (page: Page) => Promise<T>,
): Promise<T> {
  const context = await browser.newContext({ baseURL, storageState: teacherState, viewport });
  try {
    const page = await context.newPage();
    await page.goto(path);
    return await run(page);
  } finally {
    await context.close();
  }
}

/**
 * "Present" means it occupies pixels, not that it is in the DOM — see
 * course.spec.ts's identical helper and comment: `toBeVisible()` alone
 * passes for an element a mis-specified flex/grid rule has collapsed.
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

const submissionPath =
  `/courses/${fixtures.exerciseSubmission.courseSlug}` +
  `/lessons/${fixtures.exerciseSubmission.lessonSlug}` +
  `/submissions/${fixtures.exerciseSubmission.studentUserId}`;

test.describe('grading queue', () => {
  for (const { name, width, height } of WIDTHS) {
    test(`renders with no horizontal scroll at ${width} (${name})`, async ({ browser, baseURL }) => {
      await withTeacher(browser, baseURL, { width, height }, '/grading', async (page) => {
        await expect(page.getByRole('heading', { name: 'Grading queue', level: 1 })).toBeVisible();
        // The seeded exerciseSubmission (tools/src/e2e-seed.ts) is the one
        // item on the queue — its lesson title is "Add two numbers".
        const link = page.getByRole('link', { name: /Add two numbers/ });
        await expect(link).toHaveCount(1);
        await expectRendered(link, 'the queued submission link');
        await expectNoHorizontalScroll(page, `the grading queue at ${width}`);
      });
    });
  }
});

test.describe('grading view — split layout', () => {
  for (const { name, width, height } of WIDTHS) {
    const tier = tierOf(width);

    test(`every element renders at ${width} (${name}, ${tier} tier) with no horizontal scroll`, async ({
      browser,
      baseURL,
    }) => {
      await withTeacher(browser, baseURL, { width, height }, submissionPath, async (page) => {
        // The submission column: the seeded exercise's prose block, once.
        const prose = page.getByText(/An exercise lesson seeded/);
        await expect(prose).toHaveCount(1);
        await expectRendered(prose, 'the submission prose block');

        // The sidebar: the rubric heading and the return control, each once.
        await expect(page.getByRole('heading', { name: /Rubric/, level: 2 })).toHaveCount(1);
        await expectRendered(page.getByRole('heading', { name: /Rubric/, level: 2 }), 'the rubric heading');
        const returnButton = page.getByRole('button', { name: 'Return to student' });
        await expect(returnButton).toHaveCount(1);
        await expectRendered(returnButton, 'the return-to-student button');

        await expectNoHorizontalScroll(page, `the grading view at ${width}`);
      });
    });

    test(`the ${tier} tier collapses/splits the grading view at ${width}`, async ({ browser, baseURL }) => {
      await withTeacher(browser, baseURL, { width, height }, submissionPath, async (page) => {
        const mainBox = await expectRendered(page.getByText(/An exercise lesson seeded/), 'the submission column');
        const sidebarBox = await expectRendered(
          page.getByRole('heading', { name: /Rubric/, level: 2 }),
          'the rubric sidebar',
        );

        if (tier === 'narrow') {
          // Stacked: the sidebar starts at or below the bottom of the main
          // column's content, not beside it.
          expect(
            sidebarBox.y,
            'narrow tier: the rubric sidebar is not stacked below the submission column',
          ).toBeGreaterThanOrEqual(mainBox.y + mainBox.height - 1);
        } else {
          // Split: the sidebar sits to the right of the submission column,
          // roughly level with it, not stacked below.
          expect(sidebarBox.x, 'wide tier: the rubric sidebar is not to the right of the submission column').toBeGreaterThan(
            mainBox.x + mainBox.width - 1,
          );
          expect(
            sidebarBox.y,
            'wide tier: the rubric sidebar has dropped below the submission column instead of splitting beside it',
          ).toBeLessThan(mainBox.y + mainBox.height);
        }
      });
    });
  }
});
