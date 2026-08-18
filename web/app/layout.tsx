import type { Metadata, Viewport } from 'next';
import { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { IBM_Plex_Mono, Libre_Franklin, Source_Serif_4 } from 'next/font/google';
import { resolveThemePreference, THEME_COOKIE_NAME, themeDataAttribute } from '../src/lib/theme';
import { fetchIsTeacher, fetchMeOrNull } from '../src/lib/api';
import Shell from './_shell/Shell';
import './globals.css';

// next/font self-hosts these at build time (downloaded once during `next
// build`/`next dev`, then served from our own origin) — no runtime request
// to fonts.googleapis.com or any other third-party host.
const libreFranklin = Libre_Franklin({
  subsets: ['latin'],
  weight: ['500', '700'],
  variable: '--font-sans',
  display: 'swap',
});

const sourceSerif4 = Source_Serif_4({
  subsets: ['latin'],
  weight: ['400'],
  variable: '--font-serif',
  display: 'swap',
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Learn App',
  description: 'A self-hosted learning platform',
};

// viewport-fit=cover is required for env(safe-area-inset-bottom) (used by
// the bottom tab bar, design §14.2) to resolve to anything but 0 on iOS —
// without it the tab bar sits under the home-indicator gesture strip.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  // Colour-scheme preference (design §14, plan phase 4): read the cookie
  // here, in the Server Component, and apply it to the very first byte of
  // HTML — this is what makes "no flash of the wrong theme" true rather
  // than aspirational. `system` (no cookie, or an invalid one) sets no
  // data-theme attribute at all, so tokens.css's `prefers-color-scheme`
  // media query keeps deciding, exactly as it did before this feature
  // existed — the server never guesses at an OS preference it cannot see.
  const cookieStore = await cookies();
  const theme = resolveThemePreference(cookieStore.get(THEME_COOKIE_NAME)?.value);

  // Task D: the shell renders on every page, signed in or not, so it reads
  // its own session state here rather than each page fetching it — and
  // through fetchMeOrNull, which turns "no session" into null instead of
  // throwing (unlike the plain fetchMe pages use when a session IS
  // required, Task B).
  const user = await fetchMeOrNull();

  // Design §9.4 / the grading UI brief: Grading must not show to students.
  // There is no `roles` field on Me (web has no database of its own,
  // CLAUDE.md rule 1), so this asks the same question the API's own
  // `submission:queue:read` role floor answers: can this actor reach the
  // grading queue at all. Skipped entirely when signed out — Nav renders
  // nothing for that visitor regardless (see Shell), so the extra request
  // would be pure waste.
  const isTeacher = user !== null && (await fetchIsTeacher());

  return (
    <html
      lang="en"
      data-theme={themeDataAttribute(theme)}
      className={`${libreFranklin.variable} ${sourceSerif4.variable} ${ibmPlexMono.variable}`}
    >
      <body>
        <Shell theme={theme} user={user} isTeacher={isTeacher}>
          {children}
        </Shell>
      </body>
    </html>
  );
}
