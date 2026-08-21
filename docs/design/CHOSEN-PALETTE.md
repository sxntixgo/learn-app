# Santiago's Desk — chosen color & type scheme

Decided 2026-08-15. Options **9a (light)** and **9b (dark)** in `Color & Type Pairings.dc.html`.
Lineage: 1c → 2a → 4a → 6c → 7b → 8d → 9a/9b. All colors sampled from the logo
(`uploads/pasted-1786809965327-0.png`): pencil-sketch keycap on warm paper, mustard S, teal code rain.

## Type
- Headings + UI/nav: **Libre Franklin** 700 (headline tracking -0.03em), 500 for nav
- Body + prose: **Source Serif 4** 400, 16–17px, line-height 1.6–1.65, measure 46ch
- Dates, tags, labels, code: **IBM Plex Mono** 400 (labels uppercase, 0.12–0.14em tracking)

## Light (9a)
| Role | Value |
|---|---|
| Page / paper | `oklch(0.995 0.002 95)` |
| Raised surface (about box, footer strip) | `oklch(0.972 0.004 95)` |
| Hairline border | `oklch(0.915–0.925 0.003 95)` |
| Body text | `oklch(0.24 0.005 250)` / secondary `oklch(0.42 0.005 250)` |
| Top banner | `oklch(0.905 0.045 208)`, text `oklch(0.28 0.03 215)`, divider `oklch(0.855 0.05 208)` |
| Bottom banner (graphite) | `oklch(0.3 0.008 250)`, text `oklch(0.93 0.004 90)` |
| Link / date teal | `oklch(0.45 0.075 210)` |
| Tag chip | bg `oklch(0.94 0.035 205)`, text `oklch(0.42 0.06 210)` |
| Yellow (single accent) | `oklch(0.63 0.125 88)` — **corrected 2026-08-21, see below** |

## Dark (9b)
| Role | Value |
|---|---|
| Page | `oklch(0.215 0.006 245)` |
| Raised surface | `oklch(0.26 0.008 245)` |
| Hairline border | `oklch(0.31–0.33 0.008 245)` |
| Body text | `oklch(0.93 0.004 90)` / secondary `oklch(0.76–0.79 0.005 245)` |
| Top banner | `oklch(0.36 0.05 208)`, text `oklch(0.96 0.01 205)`, divider `oklch(0.43 0.055 208)` |
| Bottom banner | `oklch(0.16 0.006 250)`, text `oklch(0.82 0.004 90)` |
| Link / date teal | `oklch(0.80 0.075 205)` |
| Tag chip | bg `oklch(0.3 0.03 205)`, text `oklch(0.83 0.06 205)` |
| Yellow (single accent) | `oklch(0.82 0.15 88)` |

## The light yellow was corrected on 2026-08-21

It was `oklch(0.72 0.15 88)` from the first pass until Gate 4's first question
was finally answered with arithmetic instead of an eye. The answer was no, and
the value was wrong twice over:

1. **Outside the sRGB gamut.** Its blue channel comes out negative, so no
   browser ever showed the colour written here — every one of them clipped it
   to `#cc9d00`. What the file specified was never what shipped.
2. **2.46:1 against the page.** Rule 1 below spends this colour on the active-nav
   underline, the 2px role rule, and the about-box left edge — borders and
   state indicators, which WCAG 1.4.11 holds to 3:1 as non-text UI components.
   axe does not check border colours, which is why a passing accessibility
   suite never mentioned it.

`oklch(0.63 0.125 88)` is the brightest in-gamut yellow at the SAME hue that
clears 3:1 against both light surfaces (3.47 against the page, 3.25 against a
raised card). Hue is unchanged, so its 23-degree separation from track ochre
(H 65) is unchanged too. Dark mode measured 9.97:1, in gamut, and is untouched.

`web/src/lib/palette.test.ts` now holds the floor, and
`web/src/lib/oklch.ts` — which it uses — is itself tested against the sRGB
primaries, because a palette check is worth exactly as much as its conversion.

## Rules
1. **One yellow only.** Logo tile S, the 2px role rule, the active-nav underline, the about-box left edge. Never a fill, never body text.
2. **Logo tile is always pure white** (`#fff`) in both modes — the mustard S never sits on a tinted field.
3. Banner is the lighter band relative to its page; footer is the darkest. Same structure in both modes.
4. Teal carries links, dates and tags; graphite carries structure.
5. Mono is reserved for dates, tags, labels and code — never for prose.

## Not chosen (kept in the file for reference)
1a–1d first pass · 2b/2c yellow strategies · 3a–3c · 4b graphite hero · 5a/5b Space Grotesk ·
6a/6b/6d type alternates · 7a/7c/7d yellow dosages · 8a–8c banner pairs
