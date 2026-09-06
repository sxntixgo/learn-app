import { readFileSync } from 'node:fs';
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { E2eFixtures } from '../../tools/src/e2e-seed.ts';

/*
 * ANNOTATION GEOMETRY — measured in a browser, never read out of CSS.
 *
 * annotatable-code.module.css positions annotation cards over a Shiki block.
 * Its failure mode is not a crash and not a blank screen: it is a card that
 * sits a few pixels off the code it annotates. That renders, screenshots
 * fine, and is wrong — the same "succeeds with a wrong picture" class as the
 * server-rendered mermaid bug CLAUDE.md records.
 *
 * WHAT THIS FILE EXISTS TO CATCH, measured on 2026-09-03 before the fix:
 * every row was its own flex line, so every gutter was its own width. One
 * twelve-line seeded block drew its code at THREE different left edges —
 * 65px on a bare line, 68.59px on an annotated one, 75.59px once the line
 * number reached two digits. The cards were positioned from the other side
 * of the same assumption (`padding-left: 44px`, the gutter's MINIMUM), so
 * each card missed its code column by 3.59px, growing to 10.59px on a
 * two-digit line. The error scales with line count, so it is worst in the
 * longest files — the ones most likely to carry annotations.
 *
 * The fix is structural: the gutter and the code are two grid columns and
 * every row is a `subgrid` of them, so alignment holds by construction. This
 * file is what stops that quietly regressing. It asserts RELATIONSHIPS
 * between rendered boxes, not pixel constants, so it stays true across a
 * font change, a `--measure-*` change, or a different seeded fixture — the
 * three things that invalidated the previous arrangement.
 */

const fixtures: E2eFixtures = JSON.parse(
  readFileSync(new URL('../.fixtures.json', import.meta.url), 'utf8'),
);

const LESSON = `/courses/${fixtures.courseSlug}/lessons/${fixtures.lessonSlug}`;

// The four artboard widths (artboard-spec §3): 375/834 narrow tier,
// 1194/1440 wide. Both tiers matter here — the wide one puts a 224px rail
// and a contents panel beside the block, so the code column's own width
// differs sharply between them.
const WIDTHS = [
  { name: '375 (iPhone)', width: 375, height: 812 },
  { name: '834 (iPad portrait)', width: 834, height: 1194 },
  { name: '1194 (iPad landscape)', width: 1194, height: 834 },
  { name: '1440 (desktop)', width: 1440, height: 900 },
];

const THEMES = ['light', 'dark'] as const;

// One sign-in for the file, reused via storageState. viewport.spec.ts
// records why: concurrent Argon2id logins (design §13, deliberately
// expensive) reproduced a flake in a DIFFERENT spec twice.
let authState: Awaited<ReturnType<BrowserContext['storageState']>>;

test.beforeAll(async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await page.goto(`/login?next=${encodeURIComponent(LESSON)}`);
  await page.getByLabel('Email').fill(fixtures.viewportUser.email);
  await page.getByLabel('Password').fill(fixtures.viewportUser.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(new RegExp(`${LESSON}$`));
  authState = await context.storageState();
  await context.close();
});

async function onLesson<T>(
  browser: Browser,
  baseURL: string | undefined,
  viewport: { width: number; height: number },
  theme: 'light' | 'dark',
  run: (page: Page) => Promise<T>,
): Promise<T> {
  const context = await browser.newContext({ baseURL, storageState: authState, viewport });
  try {
    const page = await context.newPage();
    await page.goto(LESSON);
    // Pin the theme rather than relying on the OS preference, so each case
    // asserts the scheme it names (tokens.css's `[data-theme]` override).
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    // Layout depends on rendered text metrics, so the webfonts must be in.
    await page.evaluate(() => document.fonts.ready);
    await page.locator('[class*="lineRow"]').first().waitFor();
    return await run(page);
  } finally {
    await context.close();
  }
}

/** Left edges of every rendered code cell, and of every annotation card. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const round = (n: number) => Math.round(n * 100) / 100;
    const block = document.querySelector('section[class*="block"]');
    if (!block) throw new Error('no annotatable block on the page');

    const codeLefts = [...block.querySelectorAll('[class*="lineCode"]')].map((el) =>
      round(el.getBoundingClientRect().left),
    );
    /*
     * TWO DIFFERENT BOXES, and conflating them is a trap I fell into once.
     *
     * `.cardSlot` is the GRID CELL. It sits in column 2, so its left edge is
     * the thing that must agree with the code column — but `.lines` is
     * `width: max-content`, so the cell legitimately spans the whole
     * horizontal SCROLL width (468px inside a 335px block at 375). Asserting
     * that box stays inside the block fails on a correct page.
     *
     * The card itself is the sticky child, sized by `100cqi` against the
     * block's visible width. That is the box that must not overflow.
     */
    const cards = [...block.querySelectorAll('[class*="cardSlot"]')].map((slot) => {
      const slotRect = slot.getBoundingClientRect();
      const inner = slot.firstElementChild;
      const innerRect = (inner ?? slot).getBoundingClientRect();
      return { left: round(slotRect.left), cardRight: round(innerRect.right) };
    });
    const blockRight = round(block.getBoundingClientRect().right);
    return { codeLefts, cards, blockRight };
  });
}

/*
 * ONE page load per width/theme, two assertions from it — not two loads.
 *
 * The first draft ran a test per assertion: 16 contexts, 16 navigations, and
 * it pushed the whole suite from 2.7 to 6.5 minutes and timed out two
 * unrelated specs. The measurement is the expensive part and it is identical
 * for both claims, so it is taken once. Same reasoning as the storageState
 * reuse above.
 */
for (const theme of THEMES) {
  for (const { name, width, height } of WIDTHS) {
    test(`${name}, ${theme}: code and annotation cards share one column`, async ({ browser, baseURL }) => {
      const { codeLefts, cards, blockRight } = await onLesson(
        browser,
        baseURL,
        { width, height },
        theme,
        measure,
      );

      expect(codeLefts.length, 'no code lines rendered — the assertion would be vacuous').toBeGreaterThan(3);

      // THE ORIGINAL BUG, stated directly. A monospace block whose lines
      // begin at different x positions is broken however good it looks.
      const distinct = [...new Set(codeLefts)];
      expect(
        distinct,
        `code lines start at ${distinct.length} different x positions: ${distinct.join(', ')}`,
      ).toHaveLength(1);

      if (cards.length === 0) return; // the seeded lesson rendered no annotations
      const codeLeft = codeLefts[0]!;

      for (const [i, card] of cards.entries()) {
        // Sub-pixel tolerance only. 1px, not 4px: the pre-fix miss was
        // 3.59px and a tolerance that forgave it would forgive the bug.
        expect(
          Math.abs(card.left - codeLeft),
          `card ${i} starts at ${card.left}, code column at ${codeLeft}`,
        ).toBeLessThanOrEqual(1);

        // The other half of --anno-card-reserve's job: the CARD (not its
        // grid cell — see measure()) must not overflow the block's visible
        // width, or it is unreadable at the narrow tier.
        expect(
          card.cardRight,
          `card ${i} renders past the block's visible right edge`,
        ).toBeLessThanOrEqual(blockRight + 1);
      }
    });
  }
}
