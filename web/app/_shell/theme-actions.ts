'use server';

/*
 * Server Action backing the colour-scheme control (design §14, plan phase
 * 4). Same shape as the lesson reader's markLessonCompleteAction: runs on
 * the Next.js server, not the browser.
 *
 * Deliberately NOT a database write or an API call — CLAUDE.md/plan phase 4
 * are explicit that this is cookie-only scope; Phase 12 owns durable user
 * settings.
 */

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { THEME_COOKIE_MAX_AGE, THEME_COOKIE_NAME, type ThemePreference } from '../../src/lib/theme';

export async function setThemeAction(theme: ThemePreference): Promise<void> {
  const store = await cookies();
  if (theme === 'system') {
    // No cookie at all is what lets `system` keep meaning "ask the OS" —
    // see the theme.ts module comment. Deleting rather than writing
    // "system" avoids a second representation of the same fallback state.
    store.delete(THEME_COOKIE_NAME);
  } else {
    store.set(THEME_COOKIE_NAME, theme, {
      path: '/',
      maxAge: THEME_COOKIE_MAX_AGE,
      sameSite: 'lax',
    });
  }
  // The root layout reads the cookie in a Server Component, so every route
  // needs its RSC payload regenerated for the new value to show up on the
  // next paint (no client JS is required for the toggle to work at all —
  // see ThemeToggle.tsx — but this is what makes navigation-free updates
  // via the enhanced form take effect immediately).
  revalidatePath('/', 'layout');
}
