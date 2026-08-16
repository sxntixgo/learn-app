import { describe, it, expect } from 'vitest';
import { DEFAULT_TIMEZONE, isValidTimeZone } from './timezone.ts';

describe('isValidTimeZone', () => {
  it('accepts common IANA zones', () => {
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('America/Denver')).toBe(true);
    expect(isValidTimeZone('Pacific/Kiritimati')).toBe(true);
    expect(isValidTimeZone('Pacific/Niue')).toBe(true);
    expect(isValidTimeZone('Europe/London')).toBe(true);
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
  });

  it('rejects nonsense strings', () => {
    expect(isValidTimeZone('Not/A_Zone')).toBe(false);
    expect(isValidTimeZone('banana')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });

  it('rejects a bare UTC offset (not an IANA zone name)', () => {
    expect(isValidTimeZone('+05:00')).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isValidTimeZone(undefined as unknown as string)).toBe(false);
    expect(isValidTimeZone(null as unknown as string)).toBe(false);
    expect(isValidTimeZone(42 as unknown as string)).toBe(false);
  });

  it('exposes UTC as the documented fallback default', () => {
    expect(DEFAULT_TIMEZONE).toBe('UTC');
    expect(isValidTimeZone(DEFAULT_TIMEZONE)).toBe(true);
  });
});
