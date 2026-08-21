import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import type { E2eFixtures } from '../../tools/src/e2e-seed.ts';

// The `diagram` block — a ```mermaid fence, drawn (the Phase 1 finding:
// "existing content uses ```mermaid fences, currently rendered as plain
// code").
//
// This is the ONLY place the feature can be verified. The parser tests prove
// the block is produced; nothing short of a browser can show that mermaid
// loads under this app's CSP, that the drawing replaces the source, and that
// the source is still what a reader sees when it does not.
const fixtures: E2eFixtures = JSON.parse(readFileSync(new URL('../.fixtures.json', import.meta.url), 'utf8'));
const LESSON = `/courses/${fixtures.courseSlug}/lessons/${fixtures.lessonSlug}`;

test.describe.configure({ mode: 'serial' });

async function signIn(page: Page, next: string) {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel('Email').fill(fixtures.viewportUser.email);
  await page.getByLabel('Password').fill(fixtures.viewportUser.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/^(?!.*\/login).*$/);
}

test('the diagram is drawn as SVG, not printed as source', async ({ page }) => {
  await signIn(page, LESSON);

  const figure = page.locator('figure').filter({ hasText: 'How a lesson reaches a reader' });
  await expect(figure).toBeVisible();

  // The assertion that matters: an <svg> mermaid produced, containing the
  // node labels from the fence. Asserting only "an svg exists" would pass on
  // any icon on the page.
  const svg = figure.locator('svg');
  await expect(svg).toBeVisible();
  await expect(svg).toContainText('Content repo');
  await expect(svg).toContainText('Typed blocks');

  // And the source is gone, replaced rather than duplicated — two copies of
  // the same diagram is what the page looked like halfway through building
  // this.
  await expect(figure.locator('pre')).toHaveCount(0);
});

test('mermaid loads without tripping the CSP', async ({ page }) => {
  // The real risk of drawing in the browser. `script-src` is nonce +
  // 'strict-dynamic' with no 'unsafe-inline' and no 'unsafe-eval': a library
  // that needs eval would be blocked here, and the rule for this feature was
  // that the CSP does not move to accommodate it.
  const violations: string[] = [];
  await page.exposeFunction('__cspViolation', (d: string) => violations.push(d));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      const e = event as SecurityPolicyViolationEvent;
      void (window as unknown as { __cspViolation: (d: string) => void }).__cspViolation(
        `${e.effectiveDirective} <- ${e.blockedURI}`,
      );
    });
  });

  await signIn(page, LESSON);
  await expect(page.locator('figure svg').first()).toBeVisible();
  expect(violations).toEqual([]);
});

test('the caption is rendered, and the diagram is one figure', async ({ page }) => {
  await signIn(page, LESSON);
  const figure = page.locator('figure').filter({ hasText: 'How a lesson reaches a reader' });
  await expect(figure.locator('figcaption')).toHaveText('How a lesson reaches a reader');
});

test('the server sends the source, so a reader without JavaScript still has the diagram', async ({ browser }) => {
  // The fallback is not decoration: it is the whole of what the server sends,
  // and it was the entire feature before mermaid was added. Asserting on the
  // DOCUMENT the server returned — not on the page after hydration — is the
  // only way to see it, because by the time the DOM settles mermaid has
  // already replaced it.
  const context = await browser.newContext();
  try {
    const page = await context.newPage();

    // Sign in first, then navigate to the lesson as a FULL document load.
    // Reaching it through the app's own links is a client-side transition —
    // the lesson arrives as an RSC payload, there is no document response to
    // read, and an earlier version of this test silently asserted against an
    // empty string because of it.
    await signIn(page, '/');
    const response = await page.goto(LESSON);
    const documentHtml = await response!.text();

    await expect(page.locator('figure svg').first()).toBeVisible();

    // What the server actually sent: the fence body, inside a <pre>, before
    // any script ran.
    expect(documentHtml).toContain('Content repo');
    expect(documentHtml).toContain('graph LR;');
    expect(documentHtml).toMatch(/<pre[^>]*>[\s\S]*graph LR;/);
    // And no pre-rendered SVG — the server does not draw this, by design.
    expect(documentHtml).not.toContain('aria-roledescription="flowchart');
  } finally {
    await context.close();
  }
});

test('mermaid is fetched only by a page that has a diagram on it', async ({ browser }) => {
  // The justification for adding a 1.4 MB library to a deliberately small app
  // is that it is a separate chunk, loaded on demand. That claim is worth
  // nothing unverified — a stray static import anywhere in the tree would put
  // it in the shared bundle and every page would pay for it.
  //
  // Measured as SCRIPT BYTES, not chunk names, because the names are content
  // hashes and say nothing.
  //
  // The measured figures, 2026-08-21: /me fetches ~461 KB of script, a lesson
  // with a diagram ~1284 KB — a delta of ~822 KB, all of it mermaid. (Note
  // that this is smaller than the ~1.4 MB of on-disk chunks that MENTION
  // mermaid; not all of them are fetched for a flowchart.) The 500 KB
  // threshold below is deliberately well under the delta and well over
  // anything else these two pages could differ by.
  async function scriptBytesOn(path: string): Promise<number> {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await signIn(page, '/');

      let bytes = 0;
      page.on('response', (response) => {
        if (response.request().resourceType() !== 'script') return;
        void response
          .body()
          .then((b) => {
            bytes += b.length;
          })
          .catch(() => {});
      });

      await page.goto(path, { waitUntil: 'networkidle' });
      if (path === LESSON) await expect(page.locator('figure svg').first()).toBeVisible();
      await page.waitForTimeout(500);
      return bytes;
    } finally {
      await context.close();
    }
  }

  const withoutDiagram = await scriptBytesOn('/me');
  const withDiagram = await scriptBytesOn(LESSON);

  expect(withoutDiagram, '/me fetched no script at all — the measurement is broken').toBeGreaterThan(0);
  expect(
    withDiagram - withoutDiagram,
    `the lesson fetched ${withDiagram} bytes of script and /me fetched ${withoutDiagram}: mermaid does not look ` +
      `like a separate chunk`,
  ).toBeGreaterThan(500_000);
});
