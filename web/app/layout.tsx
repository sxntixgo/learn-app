import type { Metadata, Viewport } from 'next';
import { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { IBM_Plex_Mono, Libre_Franklin, Source_Serif_4 } from 'next/font/google';
import { resolveThemePreference, THEME_COOKIE_NAME, themeDataAttribute, type ThemePreference } from '../src/lib/theme';
import { fetchCanInvite, fetchCanSearch, fetchIsAdmin, fetchIsTeacher, fetchMeOrNull } from '../src/lib/api';
import type { NavAudience } from '../src/lib/nav';
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
  // iOS Safari's manifest support is partial: it does not reliably read the
  // manifest's `icons` array or `short_name` the way Android does, so the
  // apple-touch-icon link and the apple-mobile-web-app-* meta tags below
  // are what iOS actually uses for Add to Home Screen (plan Phase 14).
  icons: {
    apple: [{ url: '/icons/icon-180.png', sizes: '180x180', type: 'image/png' }],
  },
  appleWebApp: {
    capable: true,
    title: 'Learn',
    statusBarStyle: 'default',
  },
};

// viewport-fit=cover is required for env(safe-area-inset-bottom) (used by
// the bottom tab bar, design §14.2) to resolve to anything but 0 on iOS —
// without it the tab bar sits under the home-indicator gesture strip.
//
// A function rather than a static object (plan Phase 14) so theme-color can
// read the same `theme` cookie RootLayout reads below for `data-theme`.
// Unlike the JSON manifest (app/manifest.ts, which can only express ONE
// theme_color), the <meta name="theme-color"> tag supports a `media`
// attribute, so this CAN be exactly right for both colour schemes — AND
// for an explicit user override, which the manifest can't see either way:
// `system` (no cookie) emits both media-conditioned entries and lets
// `prefers-color-scheme` decide, mirroring `themeDataAttribute`'s "emit no
// override" logic for the same case; `light`/`dark` emit a single forced
// value, because a user who explicitly chose dark should not get a light
// status bar just because their OS is set to light.
export async function generateViewport(): Promise<Viewport> {
  const cookieStore = await cookies();
  const theme = resolveThemePreference(cookieStore.get(THEME_COOKIE_NAME)?.value);

  return {
    width: 'device-width',
    initialScale: 1,
    viewportFit: 'cover',
    themeColor: themeColorFor(theme),
  };
}

function themeColorFor(theme: ThemePreference): Viewport['themeColor'] {
  // --color-banner-bg, light (9a) and dark (9b) — docs/design/CHOSEN-PALETTE.md
  const LIGHT = '#bee9ef';
  const DARK = '#17444b';
  if (theme === 'light') return LIGHT;
  if (theme === 'dark') return DARK;
  return [
    { media: '(prefers-color-scheme: light)', color: LIGHT },
    { media: '(prefers-color-scheme: dark)', color: DARK },
  ];
}

/** The four role probes behind Nav's restricted destinations (see above). */
async function navAudience(signedIn: boolean): Promise<NavAudience> {
  if (!signedIn) return { isTeacher: false, canInvite: false, isAdmin: false, canSearch: false };
  const [isTeacher, canInvite, isAdmin, canSearch] = await Promise.all([
    fetchIsTeacher(),
    fetchCanInvite(),
    fetchIsAdmin(),
    fetchCanSearch(),
  ]);
  return { isTeacher, canInvite, isAdmin, canSearch };
}

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
  //
  // Phase 13 asks two more questions of the same shape — may this actor
  // issue invitations (§12), and is it an operator account (§5.1) — because
  // the answers are independent: admin is exclusive of teacher, so one
  // boolean cannot stand in for the others. Phase 16 adds a fourth, same
  // reasoning again: `search:query` carries `course:list`'s grant (student
  // only), independent of the other three. All four go out at once rather
  // than in sequence; they are four independent probes and the shell
  // renders on every page.
  const audience = await navAudience(user !== null);

  return (
    <html
      lang="en"
      data-theme={themeDataAttribute(theme)}
      className={`${libreFranklin.variable} ${sourceSerif4.variable} ${ibmPlexMono.variable}`}
    >
      <body>
        <Shell theme={theme} user={user} audience={audience}>
          {children}
        </Shell>
      </body>
    </html>
  );
}
