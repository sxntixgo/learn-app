/*
 * Colour-scheme preference (design §14, plan phase 4). Kept out of the
 * component tree so the "what does this cookie value mean" logic is
 * testable without a browser — the same reasoning as heatmap.ts and
 * activity.ts.
 *
 * `system` is not resolved to `light` or `dark` here or anywhere on the
 * server: the server does not know the visitor's OS preference, and
 * resolving it to a guessed value would be exactly the flash-of-wrong-theme
 * this feature exists to prevent. `system` means "emit no override" and let
 * `prefers-color-scheme` in tokens.css decide, same as before this feature
 * existed.
 */

export type ThemePreference = 'light' | 'dark' | 'system';

export const THEME_COOKIE_NAME = 'theme';

/** One year — long-lived like any other durable UI preference. */
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

const VALID_THEMES: ReadonlySet<string> = new Set(['light', 'dark', 'system']);

/**
 * Validates a raw cookie value into a `ThemePreference`. Anything missing,
 * malformed, or tampered with falls back to `system` rather than throwing —
 * a bad cookie should never break the page.
 */
export function resolveThemePreference(raw: string | undefined | null): ThemePreference {
  if (raw && VALID_THEMES.has(raw)) {
    return raw as ThemePreference;
  }
  return 'system';
}

/**
 * The value for `<html data-theme>`, or `undefined` to omit the attribute
 * entirely. Omitting it (for `system`) is what lets the existing
 * `prefers-color-scheme` media query in tokens.css keep deciding — see the
 * module comment above.
 */
export function themeDataAttribute(theme: ThemePreference): 'light' | 'dark' | undefined {
  return theme === 'system' ? undefined : theme;
}
