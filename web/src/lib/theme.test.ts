import { describe, expect, it } from 'vitest';
import { resolveThemePreference, themeDataAttribute } from './theme';

describe('resolveThemePreference', () => {
  it('accepts light', () => {
    expect(resolveThemePreference('light')).toBe('light');
  });

  it('accepts dark', () => {
    expect(resolveThemePreference('dark')).toBe('dark');
  });

  it('accepts system', () => {
    expect(resolveThemePreference('system')).toBe('system');
  });

  it('falls back to system when the cookie is missing', () => {
    expect(resolveThemePreference(undefined)).toBe('system');
  });

  it('falls back to system when the cookie is null', () => {
    expect(resolveThemePreference(null)).toBe('system');
  });

  it('falls back to system for an empty string', () => {
    expect(resolveThemePreference('')).toBe('system');
  });

  it('falls back to system for a tampered/unknown value', () => {
    expect(resolveThemePreference('purple')).toBe('system');
    expect(resolveThemePreference('Dark')).toBe('system');
    expect(resolveThemePreference('"; DROP TABLE users; --')).toBe('system');
  });
});

describe('themeDataAttribute', () => {
  it('passes light and dark through unchanged', () => {
    expect(themeDataAttribute('light')).toBe('light');
    expect(themeDataAttribute('dark')).toBe('dark');
  });

  it('omits the attribute for system, so prefers-color-scheme keeps deciding', () => {
    expect(themeDataAttribute('system')).toBeUndefined();
  });
});
