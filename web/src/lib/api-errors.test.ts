import { describe, expect, it } from 'vitest';
import { AuthRequiredError, classifyStatus } from './api-errors';

describe('classifyStatus', () => {
  it('treats 2xx as ok', () => {
    expect(classifyStatus(200)).toBe('ok');
    expect(classifyStatus(201)).toBe('ok');
    expect(classifyStatus(204)).toBe('ok');
  });

  it('treats 401 and 403 as auth-required, never a generic error', () => {
    expect(classifyStatus(401)).toBe('auth-required');
    expect(classifyStatus(403)).toBe('auth-required');
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
