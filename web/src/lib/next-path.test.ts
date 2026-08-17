import { describe, expect, it } from 'vitest';
import { loginRedirectPath, sanitizeNextPath } from './next-path';

describe('sanitizeNextPath', () => {
  it('falls back to / when there is no next param', () => {
    expect(sanitizeNextPath(undefined)).toBe('/');
    expect(sanitizeNextPath(null)).toBe('/');
    expect(sanitizeNextPath('')).toBe('/');
  });

  it('accepts a plain relative path', () => {
    expect(sanitizeNextPath('/courses/intro-to-ts')).toBe('/courses/intro-to-ts');
  });

  it('accepts a relative path with a query string', () => {
    expect(sanitizeNextPath('/me?tab=activity')).toBe('/me?tab=activity');
  });

  // The three required rejections (Task C): an absolute URL, a
  // protocol-relative URL, and a path-traversal attempt must all fall back
  // to '/' rather than being trusted as a redirect target.
  it('rejects an absolute URL (open redirect)', () => {
    expect(sanitizeNextPath('https://evil.example')).toBe('/');
    expect(sanitizeNextPath('http://evil.example/phish')).toBe('/');
  });

  it('rejects a protocol-relative URL', () => {
    expect(sanitizeNextPath('//evil.example')).toBe('/');
    expect(sanitizeNextPath('//evil.example/path')).toBe('/');
  });

  it('rejects a path-traversal attempt', () => {
    expect(sanitizeNextPath('/../secret')).toBe('/');
    expect(sanitizeNextPath('/courses/../../secret')).toBe('/');
    expect(sanitizeNextPath('/foo/..')).toBe('/');
  });

  it('rejects a scheme with no leading slash', () => {
    expect(sanitizeNextPath('javascript:alert(1)')).toBe('/');
    expect(sanitizeNextPath('mailto:someone@example.com')).toBe('/');
  });

  it('rejects the backslash trick browsers treat as protocol-relative', () => {
    expect(sanitizeNextPath('/\\evil.example')).toBe('/');
  });

  it('rejects control characters, including CRLF header-injection attempts', () => {
    expect(sanitizeNextPath('/foo\r\nSet-Cookie: pwned=1')).toBe('/');
    expect(sanitizeNextPath('/foo\nbar')).toBe('/');
  });

  it('rejects a value that is not a string', () => {
    expect(sanitizeNextPath(42 as unknown as string)).toBe('/');
    expect(sanitizeNextPath({} as unknown as string)).toBe('/');
  });
});

describe('loginRedirectPath', () => {
  it('builds /login?next=<encoded path>', () => {
    expect(loginRedirectPath('/')).toBe('/login?next=%2F');
    expect(loginRedirectPath('/courses/intro-to-ts')).toBe('/login?next=%2Fcourses%2Fintro-to-ts');
  });
});

describe('percent-encoded evasion', () => {
  it('rejects an encoded protocol-relative target', () => {
    // Not exploitable in a browser today (%2f is not a path separator to it),
    // but it decodes to //evil.example, so anything that normalises the path
    // before redirecting would send the visitor off-site.
    expect(sanitizeNextPath('/%2f%2fevil.example')).toBe('/');
    expect(sanitizeNextPath('/%2F%2Fevil.example')).toBe('/');
  });

  it('rejects an encoded backslash protocol-relative target', () => {
    expect(sanitizeNextPath('/%5c%5cevil.example')).toBe('/');
  });

  it('rejects encoded path traversal', () => {
    expect(sanitizeNextPath('/%2e%2e/secret')).toBe('/');
  });

  it('rejects malformed percent-encoding rather than throwing', () => {
    expect(sanitizeNextPath('/%zz')).toBe('/');
    expect(sanitizeNextPath('/%')).toBe('/');
  });

  it('still allows legitimate encoded characters in a path', () => {
    // A real course slug could contain an encoded space or accent; those
    // decode to something that is still a single same-site path.
    expect(sanitizeNextPath('/courses/my%20course')).toBe('/courses/my%20course');
  });
});
