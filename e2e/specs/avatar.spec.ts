import { readFileSync } from 'node:fs';
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import sharp from 'sharp';
import type { E2eFixtures } from '../../tools/src/e2e-seed.ts';

// Avatar uploads in a real browser (plan, Phase 12: "Avatars — generated
// identicon plus upload pipeline").
//
// api/src/profile/avatar.test.ts already proves the pipeline's four
// acceptance criteria against the decoder. What only a browser can show is
// the part in between: that a person can choose a file, that the face they
// see afterwards is the one they picked, that it survives a reload and is
// visible to a signed-out stranger, and — the assertion this file exists for
// — that the image loads AT ALL under `img-src 'self' data:`, which it can
// only do through the same-origin proxy at app/avatars/[handle]/route.ts.
//
// A DEDICATED FIXTURE ACCOUNT (`avatarUser`), for the same reason
// account-export-deletion.spec.ts uses `deletableUser`: this file mutates the
// account it signs in as, and `viewportUser` is being read live by
// viewport.spec.ts and a11y.spec.ts in other workers.
const fixturesPath = new URL('../.fixtures.json', import.meta.url);
const fixtures: E2eFixtures = JSON.parse(readFileSync(fixturesPath, 'utf8'));

test.describe.configure({ mode: 'serial' });

let ownerState: Awaited<ReturnType<BrowserContext['storageState']>>;

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

async function withPage<T>(
  browser: Browser,
  baseURL: string | undefined,
  state: Awaited<ReturnType<BrowserContext['storageState']>> | null,
  run: (page: Page) => Promise<T>,
): Promise<T> {
  const context = await browser.newContext({ baseURL, storageState: state ?? undefined });
  try {
    return await run(await context.newPage());
  } finally {
    await context.close();
  }
}

/** A recognisable solid-colour JPEG, so "did the face change" is decidable. */
async function jpegOf(r: number, g: number, b: number): Promise<Buffer> {
  return sharp({ create: { width: 320, height: 240, channels: 3, background: { r, g, b } } })
    .jpeg()
    .toBuffer();
}

async function chooseAndSave(page: Page, bytes: Buffer, name = 'me.jpg'): Promise<void> {
  await page.getByLabel('Profile picture').setInputFiles({ name, mimeType: 'image/jpeg', buffer: bytes });
  await page.getByRole('button', { name: 'Save picture' }).click();
}

test.beforeAll(async ({ browser, baseURL }) => {
  ownerState = await signIn(browser, baseURL, fixtures.avatarUser.email, fixtures.avatarUser.password);
});

test.describe('uploading a profile picture', () => {
  test('starts on the generated identicon, with no image request at all', async ({ browser, baseURL }) => {
    await withPage(browser, baseURL, ownerState, async (page) => {
      const avatarRequests: string[] = [];
      page.on('request', (request) => {
        if (request.url().includes('/avatars/')) avatarRequests.push(request.url());
      });

      await page.goto('/settings/profile');
      // The identicon is inline SVG: no request, no cache entry, nothing to
      // load. That is the point of it, so it is asserted rather than assumed.
      await expect(page.locator('svg[role="presentation"], svg[aria-hidden="true"]').first()).toBeVisible();
      expect(avatarRequests).toEqual([]);
    });
  });

  test('accepts a chosen JPEG and shows the uploaded face instead', async ({ browser, baseURL }) => {
    await withPage(browser, baseURL, ownerState, async (page) => {
      await page.goto('/settings/profile');
      await chooseAndSave(page, await jpegOf(200, 40, 40));

      await expect(page.getByText('Your picture has been updated.')).toBeVisible();

      // The <img> has to actually LOAD. `toBeVisible` is satisfied by a
      // broken image with width and height attributes, so the decoded size
      // is what gets asserted — and it is the one thing that proves the CSP,
      // the proxy route and the API all agree.
      const image = page.locator(`img[src^="/avatars/${fixtures.avatarUser.handle}"]`);
      await expect(image).toBeVisible();
      await expect
        .poll(async () => image.evaluate((el) => (el as HTMLImageElement).naturalWidth))
        .toBe(256);
    });
  });

  test('reports no CSP violation while loading it', async ({ browser, baseURL }) => {
    await withPage(browser, baseURL, ownerState, async (page) => {
      const violations: string[] = [];
      await page.exposeFunction('__cspViolation', (directive: string) => violations.push(directive));
      await page.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (event) => {
          const e = event as SecurityPolicyViolationEvent;
          void (window as unknown as { __cspViolation: (d: string) => void }).__cspViolation(
            `${e.effectiveDirective} <- ${e.blockedURI}`,
          );
        });
      });

      await page.goto('/settings/profile', { waitUntil: 'networkidle' });
      // Serving this from the API's own origin would trip `img-src 'self'`
      // here; app/avatars/[handle]/route.ts is what keeps it same-origin.
      expect(violations).toEqual([]);
    });
  });

  test('survives a reload and appears on the public page for a signed-out stranger', async ({ browser, baseURL }) => {
    await withPage(browser, baseURL, null, async (page) => {
      const response = await page.goto(`/u/${fixtures.avatarUser.handle}`);
      expect(response!.status()).toBe(200);

      const image = page.locator(`img[src^="/avatars/${fixtures.avatarUser.handle}"]`);
      await expect(image).toBeVisible();
      await expect
        .poll(async () => image.evaluate((el) => (el as HTMLImageElement).naturalWidth))
        .toBe(256);
    });
  });

  test('is served as WebP with the digest as its ETag, and re-served as 304', async ({ browser, baseURL }) => {
    await withPage(browser, baseURL, null, async (page) => {
      const first = await page.request.get(`/avatars/${fixtures.avatarUser.handle}`);
      expect(first.status()).toBe(200);
      expect(first.headers()['content-type']).toBe('image/webp');
      expect(first.headers()['x-content-type-options']).toBe('nosniff');

      const etag = first.headers()['etag'];
      expect(etag).toMatch(/^"[0-9a-f]{64}"$/);

      const second = await page.request.get(`/avatars/${fixtures.avatarUser.handle}`, {
        headers: { 'if-none-match': etag },
      });
      expect(second.status()).toBe(304);
    });
  });

  test('previews the chosen file before it is saved, and the browser can actually load it', async ({
    browser,
    baseURL,
  }) => {
    await withPage(browser, baseURL, ownerState, async (page) => {
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

      await page.goto('/settings/profile');
      await page
        .getByLabel('Profile picture')
        .setInputFiles({ name: 'preview.jpg', mimeType: 'image/jpeg', buffer: await jpegOf(10, 10, 200) });

      // `URL.createObjectURL` mints a blob: URL, which `img-src 'self' data:'
      // blocked outright — the frame stayed empty and nothing said why. The
      // decoded width is the assertion, because a blocked image is still a
      // visible element with the width and height attributes it was given.
      const preview = page.locator('img[src^="blob:"]');
      await expect(preview).toBeVisible();
      await expect.poll(async () => preview.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(320);
      expect(violations).toEqual([]);
    });
  });

  test('refuses an SVG with a message, and leaves the existing picture alone', async ({ browser, baseURL }) => {
    await withPage(browser, baseURL, ownerState, async (page) => {
      await page.goto('/settings/profile');
      await page.getByLabel('Profile picture').setInputFiles({
        name: 'sneaky.svg',
        mimeType: 'image/png',
        buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>'),
      });
      await page.getByRole('button', { name: 'Save picture' }).click();

      await expect(page.getByText(/image\/jpeg/)).toBeVisible();
      // Still the previous upload, not a hole and not the identicon.
      await expect(page.locator(`img[src^="/avatars/${fixtures.avatarUser.handle}"]`)).toBeVisible();
    });
  });

  test('replaces one picture with another, and the URL changes with it', async ({ browser, baseURL }) => {
    await withPage(browser, baseURL, ownerState, async (page) => {
      await page.goto('/settings/profile');
      const before = await page
        .locator(`img[src^="/avatars/${fixtures.avatarUser.handle}"]`)
        .getAttribute('src');

      await chooseAndSave(page, await jpegOf(20, 160, 90), 'other.jpg');
      await expect(page.getByText('Your picture has been updated.')).toBeVisible();

      // A changed image must change the URL, or every cache in the path keeps
      // showing the old face.
      await expect
        .poll(async () => page.locator(`img[src^="/avatars/${fixtures.avatarUser.handle}"]`).getAttribute('src'))
        .not.toBe(before);
    });
  });

  test('goes back to the identicon on request', async ({ browser, baseURL }) => {
    await withPage(browser, baseURL, ownerState, async (page) => {
      await page.goto('/settings/profile');
      await page.getByRole('button', { name: 'Use my identicon instead' }).click();
      await expect(page.getByText('Your picture has been removed.')).toBeVisible();

      await page.reload();
      await expect(page.locator(`img[src^="/avatars/${fixtures.avatarUser.handle}"]`)).toHaveCount(0);
      await expect(page.locator('svg[aria-hidden="true"]').first()).toBeVisible();
    });
  });

  test('answers 404 for the image once it is gone, and for a handle that never existed', async ({
    browser,
    baseURL,
  }) => {
    await withPage(browser, baseURL, null, async (page) => {
      expect((await page.request.get(`/avatars/${fixtures.avatarUser.handle}`)).status()).toBe(404);
      expect((await page.request.get('/avatars/nobody-at-all')).status()).toBe(404);
    });
  });
});
