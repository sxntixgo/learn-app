import { test, expect, type Page } from '@playwright/test';

/**
 * Gate 6's outstanding item: **open the app in a real browser with the CSP
 * on.** Until now the policy was verified structurally only —
 * `web/src/lib/csp.test.ts` asserts which directives the string contains,
 * which is a statement about a string, not about a browser. A policy can be
 * word-perfect and still break the app, or be silently inert, and neither
 * shows up in a unit test.
 *
 * It is also the check that de-risks the Next 15 → 16 upgrade. Next stamps
 * the per-request nonce onto its own inline bootstrap scripts by reading the
 * `content-security-policy` REQUEST header that `web/proxy.ts` sets. That is
 * an undocumented-looking handshake between our code and the framework's, it
 * is the reason `script-src` can omit `'unsafe-inline'`, and the file it
 * lives in was renamed by the upgrade. If a future version stops honouring
 * it, the symptom is a blank interactive app — which this file catches and a
 * string assertion cannot.
 *
 * WHY EACH ASSERTION IS HERE, rather than just "no violations":
 *
 *  - "No violations" alone is satisfiable by a page that loaded nothing.
 *    `hydrated()` proves the framework's nonce'd scripts actually EXECUTED,
 *    so a green run means the policy is both enforced and survivable.
 *  - The nonce is compared between the response header and the DOM. A
 *    mismatch means `'strict-dynamic'` grants nothing and the app is running
 *    on some other allowance.
 *  - Each nonce must be fresh. A per-deploy constant would let an injected
 *    script carry a nonce copied from any earlier page.
 */

// Routes chosen for the distinct things they make the browser load: the
// dashboard (heatmap SVG + client components), a lesson (Shiki's inline
// style attributes, the annotatable code block), and the manifest link that
// `manifest-src` governs. Anonymous routes are included because an
// unauthenticated visitor is the one whose browser an injected script would
// most like to reach.
const ROUTES = ['/', '/login', '/search?q=lesson'] as const;

interface Violation {
  directive: string;
  blocked: string;
}

/**
 * Collects CSP violations the way the BROWSER reports them, not the way we
 * imagine it would. `securitypolicyviolation` is a DOM event, so it catches
 * blocked subresources and inline handlers that never reach the console in a
 * form we could match on reliably.
 */
async function collectViolations(page: Page): Promise<Violation[]> {
  const violations: Violation[] = [];
  await page.exposeFunction('__reportCspViolation', (v: Violation) => {
    violations.push(v);
  });
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      const e = event as SecurityPolicyViolationEvent;
      void (window as unknown as { __reportCspViolation: (v: Violation) => void }).__reportCspViolation({
        directive: e.effectiveDirective || e.violatedDirective,
        blocked: e.blockedURI,
      });
    });
  });
  return violations;
}

/** True once Next's own bootstrap scripts have run — i.e. the nonce worked. */
async function hydrated(page: Page): Promise<boolean> {
  return page
    .waitForFunction(() => Array.isArray((window as unknown as { __next_f?: unknown }).__next_f), null, {
      timeout: 10_000,
    })
    .then(
      () => true,
      () => false,
    );
}

function nonceFromHeader(csp: string): string | undefined {
  return csp.match(/'nonce-([^']+)'/)?.[1];
}

test.describe('the CSP, as a browser actually applies it', () => {
  for (const route of ROUTES) {
    test(`${route} loads and runs with zero CSP violations`, async ({ page }) => {
      const violations = await collectViolations(page);

      const response = await page.goto(route, { waitUntil: 'networkidle' });
      expect(response, `no response for ${route}`).not.toBeNull();
      expect(response!.status(), `${route} should render, not error`).toBeLessThan(400);

      const csp = response!.headers()['content-security-policy'];
      expect(csp, `${route} served without a CSP — the proxy matcher missed it`).toBeTruthy();

      expect(
        await hydrated(page),
        `${route}: Next's bootstrap scripts never ran. The nonce handshake in web/proxy.ts is broken — ` +
          `script-src blocked the framework's own inline scripts.`,
      ).toBe(true);

      expect(violations, `${route} reported CSP violations`).toEqual([]);
    });
  }

  test('the nonce in the header is the nonce on the scripts', async ({ page }) => {
    const response = await page.goto('/');
    const csp = response!.headers()['content-security-policy']!;
    const headerNonce = nonceFromHeader(csp);
    expect(headerNonce, 'no nonce in the served CSP').toBeTruthy();

    // Read the IDL property, not the attribute: browsers blank the `nonce`
    // content attribute after parsing precisely so that a script cannot
    // exfiltrate it by reading the DOM.
    const domNonces = await page.evaluate(() =>
      [...document.querySelectorAll('script')].map((s) => s.nonce).filter((n): n is string => !!n),
    );

    expect(domNonces.length, 'Next stamped the nonce onto none of its scripts').toBeGreaterThan(0);
    expect([...new Set(domNonces)]).toEqual([headerNonce]);
  });

  test('every request gets a fresh nonce', async ({ page }) => {
    const seen = new Set<string>();
    for (let i = 0; i < 3; i += 1) {
      const response = await page.goto('/login', { waitUntil: 'commit' });
      const nonce = nonceFromHeader(response!.headers()['content-security-policy'] ?? '');
      expect(nonce).toBeTruthy();
      seen.add(nonce!);
    }
    expect(seen.size, 'the same nonce was reused across requests').toBe(3);
  });

  test('the web app manifest is fetchable under the policy (Phase 14)', async ({ page, context }) => {
    // The regression this guards: without `manifest-src 'self'` the browser's
    // fetch of the manifest falls through to `default-src 'none'` and is
    // blocked even though the server 200s it — so Add to Home Screen silently
    // gets nothing.
    //
    // THE FETCH HAS TO BE PROVOKED. Chromium does not download the manifest
    // on page load; it does it when something asks — the install prompt, or
    // `Page.getAppManifest` over CDP, which is the same code path. An earlier
    // version of this test called `page.request.get(href)` instead and passed
    // with `manifest-src` DELETED from the policy, because Playwright's
    // request API is not a browser fetch and no CSP applies to it. It
    // asserted that a file was served, which was never in doubt.
    //
    // Verified by mutation: with `manifest-src 'self'` removed from
    // web/proxy.ts, the request fails with errorText `csp`, the browser fires
    // `securitypolicyviolation` naming manifest-src, and `data` comes back
    // empty with a synthesized default manifest in its place.
    const violations = await collectViolations(page);
    await page.goto('/', { waitUntil: 'networkidle' });

    const href = await page.getAttribute('link[rel="manifest"]', 'href');
    expect(href, 'no <link rel="manifest"> in the document').toBeTruthy();

    const cdp = await context.newCDPSession(page);
    const result = (await cdp.send('Page.getAppManifest')) as { url?: string; data?: string };

    expect(violations.filter((v) => v.directive.includes('manifest'))).toEqual([]);
    expect(result.url, 'the browser resolved no manifest URL').toContain('manifest.webmanifest');
    expect(result.data, 'the browser fetched no manifest body').toBeTruthy();
    expect(JSON.parse(result.data!)).toMatchObject({ display: 'standalone' });
  });

  test('the other security headers are on the response, and HSTS is not (plain HTTP)', async ({ page }) => {
    const headers = (await page.goto('/'))!.headers();

    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['permissions-policy']).toContain('geolocation=()');

    // Deliberate: pinning a developer's browser to https://localhost for two
    // years is a self-inflicted outage that is tedious to undo.
    expect(headers['strict-transport-security']).toBeUndefined();
  });
});
