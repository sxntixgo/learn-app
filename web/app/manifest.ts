import type { MetadataRoute } from 'next';

/**
 * The PWA web app manifest (design decision log #6 / plan Phase 14): ships
 * now so "Add to Home Screen" gives a real icon, name, and standalone
 * launch. No service worker — offline reading is deliberately deferred
 * (design §2 non-goals): a cache-invalidation strategy tied to content
 * syncs, plus conflict handling on progress writes, is real work this
 * phase does not do.
 *
 * Uses the App Router metadata-file convention rather than a hand-written
 * route handler: Next serves this at the fixed path `/manifest.webmanifest`
 * with the correct `application/manifest+json` content type and
 * auto-injects the `<link rel="manifest">` tag into every page's <head> —
 * both of which a route handler would have to reimplement by hand.
 *
 * No `actor`/session is threaded through here, unlike API handlers
 * (CLAUDE.md rule 2) — deliberately: a manifest fetch carries no session
 * (the browser can request it before a visitor has signed in), and this
 * function calls no API route and no `can()` check, so there is nothing to
 * gate, by construction. `web/proxy.ts`'s matcher does not exclude
 * this path, so it still gets the standard security headers.
 *
 * Colours: the JSON manifest format has no equivalent of a
 * `prefers-color-scheme` media query — theme_color/background_color are
 * each a single value (unlike the `<meta name="theme-color">` HTML tag,
 * which DOES support a `media` attribute — see `generateViewport` in
 * `app/layout.tsx` for the dual-scheme version). This file therefore picks
 * ONE value: the light palette (docs/design/CHOSEN-PALETTE.md, 9a), because
 * that is the codebase's own default/fallback layer — `app/tokens.css`
 * puts light on bare `:root` and layers dark on top via
 * `prefers-color-scheme`/`data-theme`, so a static asset that can't see
 * either signal degrades to the same default the CSS itself falls back to.
 *
 * Hex values below are a mechanical sRGB conversion of the exact palette
 * tokens (see `web/scripts/generate-pwa-icons.mjs`, which performs the same
 * OKLCH conversion for the icon pixels) — not invented colours — done
 * because the manifest spec requires CSS <color> values and manifest
 * parsers (particularly on iOS, whose manifest support is partial) are not
 * guaranteed to accept `oklch()` the way a same-engine stylesheet can.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Learn App',
    short_name: 'Learn',
    start_url: '/',
    display: 'standalone',
    // --color-page (light, 9a) — app/tokens.css
    background_color: '#fefdfc',
    // --color-banner-bg (light, 9a) — app/tokens.css
    theme_color: '#bee9ef',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
