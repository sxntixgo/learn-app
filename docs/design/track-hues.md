# Five track hues — derivation

Phase 4, per design §14.1: *"Five track hues vs. an austere palette. Track hues are
derived as **OKLCH siblings of the link teal** — L and C held fixed, only H varied —
so they read as one family rather than a rainbow dropped into a restrained system."*

`hue` is constrained at the database and import-validation layer to exactly
`blue | teal | ochre | maroon | slate` (`db/migrations/0002_content_schema.sql`,
carried over from `AUTHORING.md`). This file gives those five names a value.

## The values

Defined in `web/app/tokens.css`.

| Track  | Light (`:root`)         | Dark (`prefers-color-scheme: dark`) | sRGB (light) | sRGB (dark) |
|--------|--------------------------|--------------------------------------|--------------|-------------|
| blue   | `oklch(0.52 0.095 255)`  | `oklch(0.78 0.095 255)`              | `#416b9f`    | `#8ebaf4`   |
| teal   | `oklch(0.52 0.095 175)`  | `oklch(0.78 0.095 175)`              | `#0d7a66`    | `#70ccb4`   |
| ochre  | `oklch(0.52 0.095 65)`   | `oklch(0.78 0.095 65)`               | `#8e5c26`    | `#e2ab75`   |
| maroon | `oklch(0.52 0.095 20)`   | `oklch(0.78 0.095 20)`               | `#985152`    | `#ee9f9e`   |
| slate  | `oklch(0.52 0.02 250)`   | `oklch(0.78 0.02 250)`               | `#606a74`    | `#aeb9c4`   |

L and C are fixed within a scheme for `blue`/`teal`/`ochre`/`maroon` — only H moves.
L inverts light→dark (0.52 → 0.78) the same way `--color-link` does, so every track
stays readable as a structural accent against its own page background; C stays put
across schemes.

## Why these four H values

`blue`, `teal`, `ochre` and `maroon` are the four fixed-L/C siblings. H was chosen so
each is recognisable as its name and none collide:

- **blue — H 255.** Sits in the blue zone, short of drifting into purple.
- **teal — H 175.** See "off the link" below — the constraint that actually pinned
  this number.
- **ochre — H 65.** Yellow-brown/mustard. Deliberately kept 23° clear of the single
  accent yellow's H 88 (`--color-accent-yellow`) so a track chip is never mistaken
  for the one-yellow-only accent, even though L and C already differ sharply between
  the two (accent yellow is a bright L 0.72/0.82 highlight; track ochre sits at the
  same muted L 0.52/0.78 as its siblings).
- **maroon — H 20.** Red-brown at this L/C; the low-L/C.095 combination is what
  keeps it reading as "maroon" rather than a bright red.

Adjacent gaps (255→175→65→20, wrapping 20→255) are 80°, 110°, 45°, 125° — not a
mechanical 90° split, but every neighbour clears the ~30° threshold at which two
hues at the same L/C stop being reliably distinguishable, so all four both read as
their names and stay apart from each other.

C = 0.095 was chosen (not a rounder 0.10) because 0.10 pushed light-mode teal
(H 175) out of the sRGB gamut — 0.095 is the largest chroma at which all five
tracks in both schemes stay in-gamut without clipping.

## Off the link

The link teal is `--color-link`: `oklch(0.45 0.075 210)` light, `oklch(0.8 0.075
205)` dark. Rule 2 of `CHOSEN-PALETTE.md` — "teal carries links, dates, and tags" —
means a track hue that lands on that same H would collapse two different signals
("this is a link" / "this is a track") into one.

Track teal is H 175. Distance from the link teal:

- Light: `|175 − 210| = 35°`
- Dark: `|175 − 205| = 30°`

Both clear 30°, comfortably above the ~10–15° hue step at which two colours at
matched L/C become hard to tell apart, so a reader can trust hue alone to mean
"link" or "track" but never both. This is also visible in the sRGB approximations
above: link teal is `#0a606c` (light) / `#82ccd5` (dark) — a blue-leaning teal —
against track teal's `#0d7a66` (light) / `#70ccb4` (dark), a green-leaning teal.

## `slate` is the deliberate exception

`AUTHORING.md` describes `slate` as muted, meant for background/secondary tracks —
not a sixth position on the same fixed-C ramp. It keeps the group's L (0.52 / 0.78)
but drops C to 0.02 (from 0.095), a markedly lower chroma at the same lightness. H is
250 — the same hue family as the palette's own graphite (`--color-text`,
`--color-footer-bg`, both H 245–250) — so a muted track reads as an extension of the
palette's existing "graphite carries structure" language (rule 2) rather than a
sixth arbitrary colour.

## Where hue may and may not appear

Per §14.1: **structural only** — a left-edge rule, a chip border, a small mono
label. Never a text colour, never a fill. Implemented in:

- `web/app/courses/[courseSlug]/page.tsx` / `course.module.css` — the track-list
  chips get their hue as a **border**; the table-of-contents rows whose lesson
  carries a track get a 3px **left-edge rule** in that hue. Chip background/text
  stay the palette's teal tag colours in both cases — the hue never becomes a fill
  or a text colour.
- **Phase 10's `chart` block is the one deliberate exception.** A bar's fill
  and a line's stroke are their only marks — there is no non-fill form for
  "this chart's colour" the way a chip or a TOC row has a border/rule to
  spend hue on instead. `Chart.tsx` uses `--color-track-blue` (slot 1 of the
  five) as the single-series mark colour, on the explicit understanding that
  "a chart is fill": the constraint this rule protects is palette rule 1
  (the one yellow is never a fill), not that the track ramp itself can never
  paint an area. Text (axis ticks, value labels, the caption) still never
  wears the track hue — only the bar/line mark does.

## In-gamut / contrast check

All ten values (five tracks × two schemes) render inside sRGB with no clipping at
C = 0.095 (C = 0.02 for slate). Contrast against the page background in each scheme
(WCAG relative-luminance ratio, non-text 3:1 threshold since these are structural
indicators, not text):

| Track  | Light vs. page (`0.995 0.002 95`) | Dark vs. page (`0.215 0.006 245`) |
|--------|-----------------------------------|-------------------------------------|
| blue   | 5.43                               | 8.77                                |
| teal   | 5.16                               | 9.12                                |
| ochre  | 5.56                               | 8.59                                |
| maroon | 5.70                               | 8.41                                |
| slate  | 5.42                               | 8.76                                |

All ten clear 3:1 with margin to spare. Re-derived and asserted in
`web/src/lib/palette.test.ts` on 2026-08-21; the numbers above were correct.

## What measurement changed, 2026-08-21

Two things this document asserted turned out to need correcting once the
arithmetic was actually run (`web/src/lib/oklch.ts`, `palette.test.ts`).

**"`slate` vs `blue` differ almost entirely in chroma" was the wrong worry.**
It is a real observation — they share a hue family and differ by 0.075 in
chroma — but they are not the closest pair. Under simulated deuteranopia
(Viénot 1999, on linear rgb), measured as OKLab distance:

| Pair | Normal | Worst dichromacy |
|---|---|---|
| blue / slate | 0.075 | 0.070 (protanopia) |
| **teal / slate** | 0.041 | **0.021 (deuteranopia)** |

Teal is the one that collapses toward slate, not blue — teal's chroma is
carried almost entirely on the green-red axis that deuteranopia flattens,
while slate has hardly any chroma to lose. `palette.test.ts` asserts this
ordering, so if a future change makes the documented worry the real one,
someone finds out from a failing test rather than by reading this file and
believing it.

**Why the threshold there is nonetheless low.** A track hue never appears
alone: §14.1 confines it to a chip border, a left-edge rule, or a small mono
label, and the chip and the label carry the track's NAME. Hue is a redundant
cue, so the requirement is that two tracks are not literally the same colour.
The heatmap is the opposite case — a filled square with nothing written on it
— and gets a real floor (0.04 ΔEok per step; the tightest step measures
0.051).

**Two heatmap fills are out of gamut in light mode.** `--color-heat-4`
(`0.55 0.11 210`) and `--color-heat-5` (`0.4 0.115 210`) clip. Left alone
deliberately: they are fills with no contrast requirement, and the clipped
ramp still separates at every step. Recorded in `palette.test.ts` as known,
so that a NEW out-of-gamut token fails instead of joining them quietly.
