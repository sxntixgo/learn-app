import { describe, expect, it } from 'vitest';
import { AuthRequiredError, ForbiddenError, classifyStatus } from './api-errors';

describe('classifyStatus', () => {
  it('treats 2xx as ok', () => {
    expect(classifyStatus(200)).toBe('ok');
    expect(classifyStatus(201)).toBe('ok');
    expect(classifyStatus(204)).toBe('ok');
  });

  it('separates 401 from 403, because the remedy differs', () => {
    // They were one outcome, and it produced an infinite redirect: an admin
    // account signing in landed on the catalog, `course:list` 403'd because
    // it is a student-only power (§5.1), the UI sent them to /login, /login
    // saw a valid session and sent them straight back.
    expect(classifyStatus(401)).toBe('auth-required');
    expect(classifyStatus(403)).toBe('forbidden');
  });

  it('makes ForbiddenError an AuthRequiredError, so "may this actor?" probes still work', () => {
    // api.ts asks that question in a dozen places by catching
    // AuthRequiredError and returning false. A 403 is the commonest way to
    // get that answer, so it has to keep satisfying them.
    expect(new ForbiddenError()).toBeInstanceOf(AuthRequiredError);
    expect(new ForbiddenError().name).toBe('ForbiddenError');
    // Not the other way round: only the subclass means "signing in again
    // will not help".
    expect(new AuthRequiredError()).not.toBeInstanceOf(ForbiddenError);
  });

  it('treats 404 as not-found', () => {
    expect(classifyStatus(404)).toBe('not-found');
  });

  it('treats every other status as a genuine error', () => {
    expect(classifyStatus(400)).toBe('error');
    expect(classifyStatus(409)).toBe('error');
    expect(classifyStatus(429)).toBe('error');
    expect(classifyStatus(500)).toBe('error');
  });
});

describe('AuthRequiredError', () => {
  it('is a real Error subclass, so existing `err instanceof Error` catches still work', () => {
    const err = new AuthRequiredError();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AuthRequiredError);
    expect(err.name).toBe('AuthRequiredError');
  });
});
