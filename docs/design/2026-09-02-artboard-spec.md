# Artboard spec — Claude Design import

**Source project:** "Learning app design exploration" (`fac9cb96-d7ff-4a42-8ff7-405eda411349`), owner Santiago
**Extracted:** 2026-09-02 · **Phase 0 output** of [`../plans/2026-09-02-design-import-plan.md`](../plans/2026-09-02-design-import-plan.md)

This document is what the implementation phases build from. It is a transcription, not an
interpretation — where the artboards are silent, it says so rather than filling the gap.

---

## 1. Files

All eight requested artboards exist. The three typo'd names in the request resolve cleanly:

| Requested                                     | Actual path                                  |
| --------------------------------------------- | -------------------------------------------- |
| `iPad Lanadscape Light - All Screens.dc.html` | `iPad Landscape Light - All Screens.dc.html` |
| `iPad Portraight Dark - All Screen.dc.html`   | `iPad Portrait Dark - All Screens.dc.html`   |
| _(other six)_                                 | as written                                   |

Also in the project, **not** part of the implementation: `browser-window.jsx`,
`ios-frame.jsx`, `macos-window.jsx` (device-frame mockup chrome — the rounded bezel the
screens are shown inside), `support.js`, and eight `uploads/*.png` reference pastes.

### `support.js` — **DROP, port nothing**

Header: `// GENERATED from dc-runtime/src/*.ts — do not edit`. It is the Claude Design canvas
runtime — an `<x-dc>` template parser, a Babel/React bootstrap, and a resource registry
(`src/parse.ts`, `src/compile.ts`, `src/react.ts`, `src/boot.ts`, `src/registry.ts`, …). It
attaches `window.React`, `window.ReactDOM`, `window.Babel`, `window.__resources`.

It contains exactly three colours — `#2e2c26`, `#b00020`, `#f0eee6` — all runtime error-state
chrome, none of them design tokens. **No export is design intent.** The same applies to the
`.dv-*` classes in each artboard's `<helmet>`: those are the canvas's own presentation
furniture (turn header, brief text, option chips), not app UI.

---

## 2. The finding that changes the plan: the IA moved

The artboards are **not** a restyle. From the `#merge` brief on the iPad landscape set:

> "Dashboard is gone as a destination and Home takes its place — resume, streak, activity
> feed, up next and degree progress, in one place, with the three courses you're actually
> enrolled in at the bottom. Catalog becomes pure browsing: filters, all five courses, no
> progress banner, no stats. **Nav is now Home · Catalog · Search.**"

Consequences for `web/`:

- **`/me` (Dashboard) ceases to be a nav destination.** Its content — heatmap-adjacent
  activity feed, streak, degree progress — moves onto Home.
- **Catalog loses its progress banner and stats**, becoming filters + course list.
- `NAV_DESTINATIONS` in `web/src/lib/nav.ts` changes label and shape. Note
  `nav-labels.test.ts` enforces _nav label === page `<h1>`_, so a rename is two edits the
  test binds together.
- The earlier `PL2` / `PL8` artboards that carried the duplicated banner **have already been
  deleted** from the project. The merge brief's "they stay below for reference" is stale —
  no superseded artboard remains to be confused by.

This invalidates the original plan's Assumption 4 ("routes, data and API contracts are
untouched; presentation only"). See §7.

---

## 3. Tier boundary — **answered: (b)**

The plan's blocking question was whether iPad portrait shows a sidebar or a tab bar. It is
settled three independent ways, and the answer is stronger than "similar":

| Evidence                                                                                                                               | Source               |
| -------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| iPhone and iPad portrait have the **identical eleven screen ids** `P1`–`P11` and identical labels                                      | both files           |
| iPad portrait: `.padin { flex-direction: column }` — stacked, no side rail                                                             | portrait helmet CSS  |
| iPad landscape: `.padin { display: flex }` — row, side rail                                                                            | landscape helmet CSS |
| "Nav is Home · Catalog · Search **behind the hamburger**; one column throughout, 44px minimum touch targets, body text at 17px and up" | iPad portrait brief  |
| "**Identical to the iPad landscape set**, at 1280×800 in a browser window: the same permanent **224px** teal rail — **no hamburger**"  | Desktop brief        |
| Desktop and iPad landscape share the identical eleven ids `M1 M2 PL1 PL3–PL7 PL9–PL11`                                                 | both files           |

**So there are two implementations, not four:**

| Tier       | Viewports                          | Nav                           | Layout                                                                       |
| ---------- | ---------------------------------- | ----------------------------- | ---------------------------------------------------------------------------- |
| **Narrow** | iPhone 390, iPad portrait 834      | Hamburger → drawer            | One column; contents as a **sheet**; 44px targets; body ≥17px                |
| **Wide**   | iPad landscape 1194, Desktop 1280+ | Permanent **224px** teal rail | Rail + collapsible contents panel + content; reading column capped **660px** |

**Tier boundary: 1024px** — above iPad portrait (834), below iPad landscape (1194).

> ⚠️ **Today's shell is wrong.** `app/_shell/shell.module.css` and `nav.module.css` flip to a
> sidebar at **768px**, which gives iPad portrait a rail the design does not want. Both files
> move to 1024px. The narrow tier also becomes a **hamburger drawer**, replacing today's
> fixed bottom tab bar — so `.root[data-nav-visible='true']`'s `padding-bottom` reservation
> and its hard-won specificity comment are no longer reserving space for anything.

---

## 4. Screens

Eleven per set. Wide ids `M*`/`PL*`, narrow ids `P*`; the rows are the same screens.

| Wide | Narrow | Screen                                                         | Existing route                    |
| ---- | ------ | -------------------------------------------------------------- | --------------------------------- |
| M1   | P2     | Home — resume, streak, activity, up next, degree, your courses | **routing decision — see §7 Q1**  |
| M2   | P3     | Catalog — browsing only, filters, no stats                     | `/`                               |
| PL1  | P1     | Sign in                                                        | `/login`                          |
| PL3  | P4     | Course & syllabus                                              | `/courses/[courseSlug]`           |
| PL4  | P5     | Lesson reader — contents open                                  | `/courses/…/lessons/[lessonSlug]` |
| PL5  | P6     | Lesson reader — contents collapsed / contents sheet            | same route, panel state           |
| PL6  | P7     | Checkpoint (graded)                                            | **no clear route — see §7 Q2**    |
| PL7  | P8     | Search — results                                               | `/search`                         |
| PL9  | P9     | Your profile                                                   | `/u/[handle]`                     |
| PL10 | P10    | Profile & visibility                                           | `/settings/profile`               |
| PL11 | P11    | Account & password (+ nav drawer, narrow)                      | `/settings/account`               |

### Routes with **no artboard** — out of scope, left as they are

`/grading`, `/grading/…/submissions/[userId]`, `/invites`, `/invite/[token]`,
`/admin/imports`, `/admin/people`, `/admin/audit`, `/no-access`, `/kitchen-sink`.

They still inherit the new shell and tokens, so they must be _checked_ for breakage — but
nothing redesigns them, and they are not per-screen tasks.

---

## 5. Tokens

### 5.1 Type — **the sans family changes**

```
Plus Jakarta Sans  500, 700, 800   ← replaces Libre Franklin
Source Serif 4     400, 600        ← unchanged (600 is new)
IBM Plex Mono      400, 500        ← unchanged (500 is new)
```

The artboards load these from `fonts.googleapis.com`. **The app must not.** `web/app/layout.tsx`
self-hosts via `next/font` and the CSP forbids third-party font hosts — Phase 1 of the
platform plan verified "loads with third-party hosts blocked". Plus Jakarta Sans is a
Google-hosted family, so this is a `next/font/google` swap plus two new weights on each of
the other two families.

Observed scale (light set, by frequency): mono 9.5 / 10 / 10.5 / 11 / 12 / 12.5 / 13 px;
serif 13.5 / 14 / 14.5 / 15 / 15.5 / 19 / 23 / 38 px; sans 12.5 / 15 / 15.5 / 16 / 17 / 18 / 22 px.
Headings carry tight negative tracking (−0.2px to −3px, scaling with size).

### 5.2 Colour — a full replacement, and it is **hex, not OKLCH**

The artboards are authored in hex. `app/tokens.css` is authored in OKLCH by an explicit
contract in its own header ("every value here is a direct OKLCH transcription"). Converting
is mandatory and is where gamut/contrast regressions hide — see the plan's Phase 1.

> **⚠️ Corrected 2026-09-02, after Phase 1 task 1.** Three rows here were read off frequency
> counts rather than usage. Grepping which CSS _property_ each hex sets in the raw artboards
> corrected them. See [`2026-09-02-palette.md`](./2026-09-02-palette.md) for the OKLCH values.

**Light**

| Role                        | Hex                                   | Note                                                                                                                                                    |
| --------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~Canvas / page `#F0EEE9`~~ | —                                     | **Wrong.** Occurs exactly once, in the `<helmet>` `body{}` — the canvas backdrop _outside_ the device frame. Zero uses in any screen; not an app colour |
| Page                        | `#FDFCF7`                             | The `.padin` ground, inside the frame                                                                                                                   |
| Surface (raised)            | `#FBFAF6`                             | `#F4F3EC` / `#F2F2EC` collapse into these two (ΔE 0.58 and 0.39 — imperceptible)                                                                        |
| Text                        | `#17201F`                             | 16.19:1 on page                                                                                                                                         |
| Text secondary              | `rgba(23,32,31,.45–.6)`               | 23 distinct alpha stops across the set — a hand-drawn continuum, not tiers. Bake to solid                                                               |
| Border hairline             | `#E5E3DA`, `rgba(23,32,31,.12)`/`.14` |                                                                                                                                                         |
| Link / primary teal         | `#0E5457`                             | 8.43:1 on page                                                                                                                                          |
| Teal deep / mid / light     | `#0A3F41` · `#3F8E96` · `#7FC3CB`     |                                                                                                                                                         |
| Teal rail                   | `#BFE4E9`                             | The 224px nav rail's ground                                                                                                                             |
| **Gold — indicator**        | `#C08A17`                             | `background` ×3, `border-left` ×9 → non-text, **3:1 floor. FAILS: 2.25 rail / 2.97 page / 2.92 card.** See §5.2.2                                       |
| **Gold — text**             | `#8A6410`                             | `color` ×22 → text, **4.5:1 floor.** 5.23 page / 5.14 card / 3.96 rail                                                                                  |
| ~~Dark surfaces (footer)~~  | —                                     | **Wrong.** `#25302E` and `#1F2A28` are only ever `color:` — text tones, never a background                                                              |
| Error                       | `#8C3A24`                             |                                                                                                                                                         |

**Dark** — the iPhone dark brief states the derivation explicitly: _"the light set, re-toned
rather than re-drawn — same eleven screens, same structure."_

| Role                  | Hex                                         | Note                                                                    |
| --------------------- | ------------------------------------------- | ----------------------------------------------------------------------- |
| Canvas                | `#0E1112`                                   | Backdrop outside the frame — not an app colour, same as `#F0EEE9`       |
| Page                  | `#14191A`                                   |                                                                         |
| Panel / card / deep   | `#222829` · `#1C2223` · `#062024`           | The two raised greys stay distinct — a real, deliberate step            |
| Text / body           | `#ECEFEE` · `#D6DDDB`                       | Body is **never pure white** — stated in the brief. 12.86:1             |
| Border hairline       | `#2E3536`, `rgba(236,239,238,.12)`/`.14`    |                                                                         |
| Link / primary teal   | `#46909A`                                   | 4.83:1 on page; carries dark labels when used as a fill                 |
| Teal light / deep bar | `#82B3BA`, `#6FB3BB` · `#072C2E`, `#1E5055` |                                                                         |
| **Gold — indicator**  | `#A67C25`                                   | `background` ×3, `border-left` ×9 → 3:1 floor. 4.67 page / 3.94 panel ✓ |
| **Gold — text**       | `#CFA23F`                                   | `color` ×21 → 4.5:1 floor. 7.51 page / 6.34 panel ✓                     |
| Error                 | `#E28B72`                                   |                                                                         |

### 5.2.1 The heatmap ramp is in the artboards — five steps, not six

Both sets define it literally, so it needed no invention:

```js
light: ['#E5E3DA', '#BFE4E9', '#7FC3CB', '#3F8E96', '#0E5457'];
dark: ['#252B2C', '#82B3BA', '#46909A', '#1E5055', '#072C2E'];
```

Built entirely from colours already in the tables above. **This is five steps; `tokens.css`
today has six (`--color-heat-0` … `--color-heat-5`) and `palette.test.ts` loops over all
six.** Dropping a step is a real change to both files, not a re-tint.

### 5.2.2 ⚠️ Light indicator gold does not clear its floor

`#C08A17`'s job is `border-left` (×9) and `background` (×3) — a non-text UI component under
WCAG 1.4.11, floor 3:1. It measures **2.25:1 on the rail, 2.97:1 on the page, 2.92:1 on a
card**. It is in gamut, so unlike the old yellow the browser does show the specified colour;
it is simply too light for the job it is given.

Same failure class as `--color-accent-yellow`, which `tokens.css` documents at length
("wrong twice, both measurable and neither visible by eye"). That precedent held the hue and
took the brightest in-gamut value clearing 3:1. Applied here at hue 79:

```
oklch(0.596 0.124 79)  =  #a67500     rail 3.01:1 · page 3.97:1 · card 3.91:1
```

A **correction, not a redesign** — but it deviates from the artboard, and Gate 1 is where a
human accepts or overrides it. Light _text_ gold `#8A6410` is fine on page and card
(5.23 / 5.14) but sits at **3.96:1 on the rail**, under the 4.5:1 text floor; Phase 1's audit
task must establish whether gold text ever lands on the rail.

> **⚠️ Corrected 2026-09-02, after Phase 1 task 7 (the audit).** Two things above are wrong,
> and they are wrong in the same way.
>
> **The "rail" figures in this section and in the tables above are measured against
> `#BFE4E9`, which is the rail's _text_, not its ground.** The light rail's background is
> `#0E5457` — `width:224px;background:#0E5457`, on all seven screens of
> `iPad Landscape Light`. Against the real ground, indicator gold `#C08A17` is 2.84:1 (not
> 2.25) and text gold `#8A6410` is 1.62:1 (not 3.96).
>
> **The correction above does not fix the rail, and nothing can.** `#a67500` measures 2.13:1
> against `#0E5457`. Light's page and rail are 8.43:1 apart, so the best any single colour
> can hold against both is `sqrt(8.43)` = 2.90:1, under the floor before a value is chosen.
> `tokens.css` ships `#a67500` for the page and card cases (3.97 / 3.63), where gold is the
> only signal; on the rail the current item also carries bold weight, a different family, a
> brighter text colour and a tinted background. `web/src/lib/palette.test.ts` asserts the
> impossibility so it cannot be forgotten.
>
> **The question this section asks is answered: no, gold text never lands on the rail.** All
> 22 `color:#8A6410` occurrences are on the page or a card; the rail's text is `#fff` and
> alphas of `#BFE4E9`. The audit asserts the pairing stays illegal rather than leaving it
> unmentioned. See `docs/design/2026-09-02-palette.md` §5.7.

Two dark-mode decisions worth preserving verbatim from the brief: body text is `#D6DDDB`
rather than white, and the degree card **inverts to teal-on-dark** instead of the light set's
cyan block, "which would have glared."

### 5.3 Radii — normalize, do not transcribe

The artboards use fifteen distinct radii (2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 99px)
— hand-drawn variance, not a scale. Map onto the existing `--radius-sm/md/lg/pill`, adding at
most one step. Transcribing fifteen values would import noise as if it were intent.

### 5.4 Measures

- Wide reading column: **660px** (Desktop brief, explicit).
- Wide nav rail: **224px** (Desktop brief, explicit).
- Narrow: one column, body ≥17px, touch targets ≥44px.
- Other observed widths: 140, 220, 260, 276, 400, 520, 600, 620, 640px (panels and cards).

> **Conflict to resolve:** today's `--measure-prose` is `46ch` and design §14.2 requires it
> stay **constant across breakpoints**. The artboards specify `660px` at wide and give no ch
> value. 660px ≈ 46ch only at a particular size/family, and the family is changing. Decide
> deliberately — see §7 Q3.

---

## 6. Layout deltas

**Wide (iPad landscape + Desktop) — verified from M1:**

Rail (224px, teal) top to bottom: logo "Learn App" · nav Home / Catalog / Search ·
`ENROLLED` course list · account "Santiago ▾" pinned at the bottom. This is richer than
today's `Nav`, which is three links and nothing else — the enrolled-course list and the
account control both move _into_ the rail.

Home main column: percent-complete resume banner (`42%`, module · lesson · duration, title,
course) with streak and this-week time, and a `Resume →` action · timezone line
("Times shown in America/Denver.") · two-column _Recent activity_ / _Up next_ + _Degree
progress_ · _Your courses_ with a `BROWSE CATALOG →` link and numbered course rows.

Lesson reader: rail + **collapsible contents panel** (PL4 open, PL5 collapsed) + reading column.

**Narrow (iPhone + iPad portrait):** one column throughout; nav behind a hamburger drawer
(P11); module contents get their own **sheet** (P6) rather than a side panel.

---

## 7. Open questions — these need a human before Phase 2

1. **Which route is Home?** The design has three destinations (Home · Catalog · Search) and
   the app has `/me` (Dashboard) and `/` (Catalog). Either **(a)** `/me` becomes Home and `/`
   stays Catalog — no routing change, but "Home" living at `/me` is odd and every existing
   `/me` link keeps working; or **(b)** `/` becomes Home and Catalog moves to a new
   `/catalog` — reads correctly, costs a route plus redirects from `/me`. Affects `nav.ts`,
   `nav-labels.test.ts`, and several specs.
2. ~~**What is Checkpoint (PL6/P7)?**~~ — **answered 2026-09-03: a quiz-kind lesson at the
   existing route. No new route.** Evidence: `api/src/content/parse.ts` already declares
   `LessonKind = 'lesson' | 'exercise' | 'quiz'`, and the reader already renders
   `block.type === 'quiz'` through `Quiz.tsx`, scored via its own `.../quiz` endpoint rather
   than `MarkCompleteButton`. PL6 corroborates it: the screen carries a back link to the
   _previous lesson_ (`← THE BASE CASE`), an eyebrow reading
   `CHECKPOINT · 2 QUESTIONS · PASS AT 2`, and **no contents panel** — a focused lesson, not
   a new destination. So Phase 3 restyles the existing quiz-kind lesson rendering.

3. ~~**`--measure-prose`: keep `46ch`, or move to 660px?**~~ — **answered 2026-09-03, and
   the premise was wrong: 660px is not in the artboards.** It appears exactly once in the
   whole project, in the Desktop brief's _prose_ ("Reading column capped at 660px"), and
   **nowhere in any artboard's CSS**. What the artboards actually draw in the reader is
   `max-width: 600px` with prose at **19px** Source Serif 4 / 1.72.

   So the reconciliation is: **keep the `ch` unit** — it is font-relative, which is the
   property design §14.2 actually cares about, and it survives the family swap — and set the
   value so the rendered column lands on the artboards' drawn 600px at their 19px body size.
   The app renders 414px today (46ch at 17px), so this widens the column **and** raises the
   reading size, both per the artboards. Measure it in a browser rather than deriving `ch`
   from glyph metrics by hand.

> **Q1 answered (2026-09-02, pending human review): option (a).** `/me` becomes Home, `/`
> stays Catalog. `NAV_DESTINATIONS` was already `['/me', '/', '/search']` in the design's own
> order, so the new IA is a relabel — no route, no redirect, no churn. The rationale and the
> one-line reversal path are recorded in `web/src/lib/nav.ts`.

## 8. What did not change

Routes with no artboard (§4), the API contract, the block model, Shiki-at-render-time, the
three-tier measure system's _shape_, `data-theme` as the theme mechanism, and
`check-css-tokens` as the guard that keeps the theme axis free.
