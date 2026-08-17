import { describe, expect, it } from 'vitest';
import { parseSetCookie } from './auth-cookies';

describe('parseSetCookie', () => {
  it('parses name, value, and the flags the API actually sets (auth/cookies.ts)', () => {
    const parsed = parseSetCookie('learn_at=abc123; Path=/; Max-Age=900; HttpOnly; Secure; SameSite=Lax');
    expect(parsed).toEqual({
      name: 'learn_at',
      value: 'abc123',
      path: '/',
      maxAge: 900,
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
    });
  });

  it('parses the refresh cookie, scoped to the auth path', () => {
    const parsed = parseSetCookie('learn_rt=xyz; Path=/api/v1/auth; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax');
    expect(parsed?.path).toBe('/api/v1/auth');
    expect(parsed?.maxAge).toBe(2592000);
  });

  it('parses a clearing cookie (empty value, Max-Age=0) the same way — clearSessionCookies produces this', () => {
    const parsed = parseSetCookie('learn_at=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax');
    expect(parsed).toMatchObject({ name: 'learn_at', value: '', maxAge: 0 });
  });

  it('defaults httpOnly/secure to false and omits attributes that are absent', () => {
    const parsed = parseSetCookie('theme=dark; Path=/');
    expect(parsed).toEqual({ name: 'theme', value: 'dark', path: '/', httpOnly: false, secure: false });
  });

  it('is case-insensitive on attribute names', () => {
    const parsed = parseSetCookie('a=b; PATH=/; httponly; SECURE; samesite=Strict');
    expect(parsed).toMatchObject({ path: '/', httpOnly: true, secure: true, sameSite: 'strict' });
  });

  it('returns null for a header with no name=value pair', () => {
    expect(parseSetCookie('')).toBeNull();
    expect(parseSetCookie('   ')).toBeNull();
    expect(parseSetCookie('; Path=/')).toBeNull();
  });

  it('parses Expires into a Date', () => {
    const parsed = parseSetCookie('a=b; Expires=Wed, 09 Jun 2027 10:18:14 GMT');
    expect(parsed?.expires).toBeInstanceOf(Date);
    expect(parsed?.expires?.getUTCFullYear()).toBe(2027);
  });
});
