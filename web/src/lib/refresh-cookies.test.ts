import { describe, it, expect } from 'vitest';
import { parseSetCookie } from './auth-cookies.ts';

/**
 * The two places a refresh cookie is re-issued on web's origin must agree
 * about its path, or a session that refreshes once becomes unrenewable
 * afterwards — the failure would look like "logged out after 15 minutes,
 * but only sometimes".
 *
 * This asserts the RULE both implementations follow. `relaySetCookies`
 * (login) applies it through `pathOnThisOrigin`; `proxy.ts` (refresh)
 * applies it through `rescopeRefreshCookie`.
 */
const REFRESH_FROM_API = 'learn_rt=abc123; Path=/api/v1/auth; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax';

/** The regex proxy.ts uses. Kept here so the rewrite is covered by a test. */
function rescope(header: string): string {
  if (!header.startsWith('learn_rt=')) return header;
  return header.replace(/;\s*Path=[^;]*/i, '; Path=/');
}

describe('the refresh cookie is re-scoped to this origin', () => {
  it('rewrites Path=/api/v1/auth to Path=/', () => {
    // Nothing is served under /api/v1/auth on web's origin, so a cookie
    // scoped there is one the browser never sends anywhere.
    expect(rescope(REFRESH_FROM_API)).toContain('Path=/;');
    expect(rescope(REFRESH_FROM_API)).not.toContain('/api/v1/auth');
  });

  it('keeps every other attribute intact', () => {
    const parsed = parseSetCookie(rescope(REFRESH_FROM_API));
    expect(parsed).toMatchObject({
      name: 'learn_rt',
      value: 'abc123',
      path: '/',
      maxAge: 2592000,
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
    });
  });

  it('leaves the access cookie alone — it is already scoped to /', () => {
    const access = 'learn_at=tok; Path=/; Max-Age=900; HttpOnly; Secure; SameSite=Lax';
    expect(rescope(access)).toBe(access);
  });

  it('rewrites a clearing cookie too, so a revoked session is actually cleared', () => {
    // The API clears at its own path. Clearing at a path the browser never
    // stored the cookie under would leave the dead token in place forever.
    const cleared = 'learn_rt=; Path=/api/v1/auth; Max-Age=0; HttpOnly; Secure; SameSite=Lax';
    const parsed = parseSetCookie(rescope(cleared));
    expect(parsed).toMatchObject({ name: 'learn_rt', value: '', path: '/', maxAge: 0 });
  });
});
