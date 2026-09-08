import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  contrastRatio,
  inSrgbGamut,
  oklchToLinearRgb,
  toHex,
  worstCaseDistance,
  type LinearRgb,
} from './oklch.ts';

/**
 * THE FLOOR UNDER app/tokens.css.
 *
 * Every colour token this app ships gets a threshold here that matches the
 * job it does — 4.5:1 if it is text, 3:1 if it is a non-text UI component
 * (WCAG 1.4.11), a perceptual-separation floor if it is a heatmap fill where
 * colour is the only signal — and it is measured against the grounds it
 * actually sits on, read out of the artboards, not against the page by
 * default. A token with no declared role fails, so the sheet cannot rot by
 * someone adding a colour and not saying what it is for.
 *
 * WHY THAT IS WORTH THE TROUBLE. `--color-accent-yellow` shipped for five
 * phases both OUT OF SRGB GAMUT (so the browser clipped it and the value in
 * tokens.css was never the value on the screen) and at 2.46:1 against a 3:1
 * threshold, while 69 passing accessibility assertions elsewhere in this
 * repo said nothing. Neither fact is visible to an eye. Both are one line of
 * arithmetic.
 *
 * WHAT THIS FILE FOUND when the artboard palette landed (Phase 1, 2026-09-02
 * — all four fixed in tokens.css, each documented in place there):
 *
 *  - light `--color-text-secondary`, baked from the artboards' .6 alpha
 *    stop, was 4.38:1 on the page and 4.00:1 on a card. Captions are body
 *    text; the floor is 4.5.
 *  - light `--color-heat-0` and `--color-heat-1`, transcribed literally,
 *    were 0.0242 ΔEok apart under protanopia against a 0.04 floor. The ramp
 *    is the one place in this palette where colour is the only signal.
 *  - dark `--color-link` was 4.07:1 on `--color-surface-raised`, and the
 *    artboards do draw an inline link on one.
 *  - dark `--color-accent-gold-text` had been merged onto the indicator
 *    gold by a frequency reading of the artboards, and failed as text at
 *    3.95:1 on a raised surface. The artboards draw two distinct golds.
 *
 * And one thing it could NOT fix, recorded as an assertion below rather than
 * left as prose: in light mode `--color-page` and `--color-rail-bg` are
 * 8.43:1 apart, so no single indicator colour can clear 3:1 against both.
 *
 * WHAT IT DELIBERATELY DOES NOT DO is decide whether a colour is nice, or
 * whether ochre reads as "ochre". Those need eyes. Everything below is a
 * number that was previously being guessed at.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const rawCss = readFileSync(path.resolve(here, '../../app/tokens.css'), 'utf8');

/**
 * Comments are stripped BEFORE anything else looks at the file, so a value
 * quoted inside one of tokens.css's (long, numerous) explanatory comments
 * can never be mistaken for a declaration. Every index below is into the
 * stripped source.
 */
const tokensCss = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Splits the file at the dark block. The light values live in the bare
 * `:root`; `@media (prefers-color-scheme: dark)` and the `[data-theme='dark']`
 * override that follows it carry the same dark values (tokens-dark-blocks.
 * test.ts is what holds those two to each other), so reading from the media
 * query onward is enough.
 */
const DARK_BLOCK_START = tokensCss.indexOf('@media (prefers-color-scheme: dark)');

const OKLCH_DECLARATION = /(--color-[a-z0-9-]+):\s*oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)/g;
const ANY_COLOR_DECLARATION = /(--color-[a-z0-9-]+)\s*:/g;

function tokensIn(source: string): Map<string, LinearRgb> {
  const found = new Map<string, LinearRgb>();
  for (const match of source.matchAll(OKLCH_DECLARATION)) {
    // First definition wins: the dark slice defines each token once in the
    // media query and again in the [data-theme] block, with the same value.
    if (!found.has(match[1]!)) {
      found.set(match[1]!, oklchToLinearRgb(Number(match[2]), Number(match[3]), Number(match[4])));
    }
  }
  return found;
}

function declaredNamesIn(source: string): Set<string> {
  return new Set([...source.matchAll(ANY_COLOR_DECLARATION)].map((match) => match[1]!));
}

const SOURCE = {
  light: tokensCss.slice(0, DARK_BLOCK_START),
  dark: tokensCss.slice(DARK_BLOCK_START),
} as const;

const SCHEMES = {
  light: tokensIn(SOURCE.light),
  dark: tokensIn(SOURCE.dark),
} as const;

type Scheme = keyof typeof SCHEMES;
const BOTH_SCHEMES = ['light', 'dark'] as const;

function token(scheme: Scheme, name: string): LinearRgb {
  const value = SCHEMES[scheme].get(name);
  if (!value) throw new Error(`${name} is not defined in the ${scheme} scheme`);
  return value;
}

const TRACKS = ['blue', 'teal', 'ochre', 'maroon', 'slate'] as const;

/** The heatmap ramp is FIVE steps, 0..4 — the artboards' own `steps` array. */
const RAMP_STEPS = 5;

/**
 * Tokens that are not written as `oklch(...)` and are therefore invisible to
 * every measurement in this file. The list exists so that adding a second
 * one is a failing test rather than a silent hole: a hex or a `color-mix()`
 * slipped into tokens.css would otherwise simply not be checked by anything.
 */
const NOT_MEASURABLE = ['--color-logo-tile'];

/**
 * Deprecated aliases: a token whose consumer has not migrated yet, pointing
 * at the token that replaces it (tokens.css's header explains the renames).
 * Asserted equal, so an alias cannot quietly drift away from its target and
 * start shipping a colour nobody chose for it.
 */
const ALIASES: Record<string, string> = {
  '--color-banner-bg': '--color-rail-bg',
  '--color-banner-text': '--color-rail-text',
  '--color-banner-divider': '--color-rail-text',
};

/**
 * THE ROLE TABLE. Every token gets exactly one entry, and the grounds are
 * the ones the artboards actually put it on — several of them are NOT the
 * page, and two of them differ between light and dark, which is the whole
 * reason this is a table and not a loop over `--color-page`.
 *
 *   text     WCAG AA body text, 4.5:1. Used for anything rendered as glyphs,
 *            including 10px mono eyebrows — none of this palette's text
 *            roles are large text (18.66px bold / 24px).
 *   ui       WCAG 1.4.11 non-text UI component or graphical object, 3:1.
 *   ramp     A heatmap fill. No contrast requirement at all; held instead to
 *            a perceptual-separation floor against its neighbours, below.
 *   hairline A divider or cell stroke. 1.4.11 exempts these (they carry no
 *            information), but a hairline nobody can see is still a bug, so
 *            they get a visibility floor rather than a contrast ratio.
 *   ground   Something else is measured against it.
 *   backdrop Not app UI: the canvas the device-frame mockups sit on.
 */
type Role =
  | { kind: 'text'; grounds: readonly string[] }
  | { kind: 'ui'; grounds: readonly string[] }
  | { kind: 'ramp' }
  | { kind: 'hairline'; grounds: readonly string[] }
  | { kind: 'ground' }
  | { kind: 'backdrop' };

/** The three tones a card or panel can be, plus the page itself. */
const PAGE_AND_CARDS = ['--color-page', '--color-surface-raised', '--color-surface-card'] as const;

function rolesFor(scheme: Scheme): Record<string, Role> {
  /**
   * `--color-text-on-accent` is the one token whose ground genuinely differs
   * by theme, and it is worth naming both. Light draws dark teal text on the
   * pale teal block only (`background:#BFE4E9`, the "Resume →" pill and the
   * degree-progress card); light's deep teal `#0E5457` fills carry white or
   * `--color-rail-text` instead. Dark draws it on the mid teal fills — the
   * "SIGN IN" / "MARK COMPLETE" / "SEARCH" pills are `--color-link`, and the
   * "Resume →" pill is the light teal that is also `--color-heat-1`.
   */
  const accentFills =
    scheme === 'light'
      ? (['--color-rail-text'] as const)
      : (['--color-link', '--color-rail-text', '--color-heat-1'] as const);

  /**
   * Dark's rail is only 1.19:1 from its page, so the indicator gold clears
   * 3:1 there as well as on a card. Light's rail is 8.43:1 from its page and
   * no single value can clear both — see the impossibility assertion below,
   * which is why the light list stops at the cards.
   */
  const goldGrounds =
    scheme === 'light' ? PAGE_AND_CARDS : ([...PAGE_AND_CARDS, '--color-rail-bg'] as const);

  return {
    // Grounds.
    '--color-canvas': { kind: 'backdrop' },
    '--color-page': { kind: 'ground' },
    '--color-surface-raised': { kind: 'ground' },
    '--color-surface-card': { kind: 'ground' },
    '--color-rail-bg': { kind: 'ground' },
    '--color-tag-bg': { kind: 'ground' },
    '--color-banner-bg': { kind: 'ground' },
    '--color-footer-bg': { kind: 'ground' },

    // Text.
    '--color-text': { kind: 'text', grounds: PAGE_AND_CARDS },
    '--color-text-secondary': { kind: 'text', grounds: PAGE_AND_CARDS },
    '--color-text-reading': { kind: 'text', grounds: PAGE_AND_CARDS },
    '--color-link': { kind: 'text', grounds: PAGE_AND_CARDS },
    '--color-error': { kind: 'text', grounds: PAGE_AND_CARDS },
    '--color-accent-gold-text': { kind: 'text', grounds: PAGE_AND_CARDS },
    '--color-rail-text': { kind: 'text', grounds: ['--color-rail-bg'] },
    '--color-tag-text': { kind: 'text', grounds: ['--color-tag-bg'] },
    '--color-text-on-accent': { kind: 'text', grounds: accentFills },
    '--color-banner-text': { kind: 'text', grounds: ['--color-banner-bg'] },
    '--color-footer-text': { kind: 'text', grounds: ['--color-footer-bg'] },

    // Non-text UI.
    '--color-accent-gold': { kind: 'ui', grounds: goldGrounds },
    ...Object.fromEntries(
      TRACKS.map((track) => [
        `--color-track-${track}`,
        { kind: 'ui', grounds: ['--color-page', '--color-surface-raised'] } as Role,
      ]),
    ),

    // Heatmap fills.
    ...Object.fromEntries(
      Array.from({ length: RAMP_STEPS }, (_, step) => [`--color-heat-${step}`, { kind: 'ramp' } as Role]),
    ),

    // Hairlines.
    '--color-border-hairline': { kind: 'hairline', grounds: ['--color-page', '--color-surface-raised'] },
    '--color-heat-cell-edge': { kind: 'hairline', grounds: ['--color-heat-0'] },
    '--color-banner-divider': { kind: 'hairline', grounds: ['--color-banner-bg'] },
  };
}

describe('the token file parses at all', () => {
  // Every assertion below is vacuous if these regexes stop matching — a
  // reformatted tokens.css would turn the whole file green by finding
  // nothing to check.
  it('finds both schemes, with the same set of colour tokens in each', () => {
    expect(DARK_BLOCK_START).toBeGreaterThan(0);
    expect(SCHEMES.light.size).toBeGreaterThan(20);
    expect([...SCHEMES.dark.keys()].sort()).toEqual([...SCHEMES.light.keys()].sort());
  });

  for (const scheme of BOTH_SCHEMES) {
    it(`${scheme}: every colour token is written as oklch(), so every one of them is measurable`, () => {
      // A token written as a hex, a keyword or a color-mix() parses out of
      // the regex above and is then checked by nothing whatsoever. That is
      // exactly how a bad value hides, so the escape hatch is enumerated.
      const unmeasured = [...declaredNamesIn(SOURCE[scheme])].filter((name) => !SCHEMES[scheme].has(name));
      expect(unmeasured.sort()).toEqual([...NOT_MEASURABLE].sort());
    });

    it(`${scheme}: every token has a declared role, and every declared role has a token`, () => {
      const roles = rolesFor(scheme);
      const declared = [...SCHEMES[scheme].keys()].sort();
      const classified = Object.keys(roles).sort();
      // Both directions on purpose. A new token with no role would otherwise
      // be held to nothing; a role left behind by a deleted token would rot
      // into a reference to a name that no longer exists.
      expect(declared, 'a token in tokens.css with no role in this file').toEqual(classified);
    });
  }
});

describe('deprecated aliases still point at what they claim to', () => {
  /**
   * These names survive only until their consumers migrate (Phases 2-5 of
   * docs/plans/2026-09-02-design-import-plan.md). Until then they ship, so
   * they are held to their target's value — an alias that drifts is a colour
   * nobody chose, appearing in components nobody has looked at lately.
   */
  for (const scheme of BOTH_SCHEMES) {
    for (const [alias, target] of Object.entries(ALIASES)) {
      it(`${scheme}: ${alias} === ${target}`, () => {
        expect(toHex(token(scheme, alias))).toBe(toHex(token(scheme, target)));
      });
    }
  }
});

describe('every colour is one a screen can actually show', () => {
  /**
   * An out-of-gamut token is not a style opinion: the browser clips it, so
   * the value in tokens.css is not the value on the screen, and every later
   * judgement about it is about a colour nobody chose. The pre-import
   * palette carried three — the accent yellow (which also failed its
   * contrast floor) and two heatmap fills that were tolerated because a fill
   * carries no contrast requirement. The artboard palette carries none, so
   * the expected list is empty and a new one fails here.
   */
  for (const scheme of BOTH_SCHEMES) {
    it(`${scheme}: nothing is out of gamut`, () => {
      const outOfGamut = [...SCHEMES[scheme].entries()]
        .filter(([, rgb]) => !inSrgbGamut(rgb))
        .map(([name]) => name);

      expect(outOfGamut, `these clip to something other than what tokens.css says`).toEqual([]);
    });
  }
});

describe('text clears 4.5:1 on every ground it actually sits on', () => {
  /**
   * The ordinary WCAG AA floor for body copy. None of this palette's text
   * roles qualify as large text (18.66px bold or 24px): the smallest are the
   * 9.5-11px mono eyebrows, which are the strictest case, not an exempt one.
   */
  for (const scheme of BOTH_SCHEMES) {
    const roles = rolesFor(scheme);
    for (const [name, role] of Object.entries(roles)) {
      if (role.kind !== 'text') continue;
      it(`${scheme}: ${name}`, () => {
        for (const ground of role.grounds) {
          const ratio = contrastRatio(token(scheme, name), token(scheme, ground));
          expect(ratio, `${toHex(token(scheme, name))} on ${ground}`).toBeGreaterThanOrEqual(4.5);
        }
      });
    }
  }
});

describe('non-text UI clears 3:1 on every ground it actually sits on', () => {
  /**
   * WCAG 1.4.11. The golds are `border-left` and `background` — an active-nav
   * indicator, a callout's left rule, an activity dot, a badge disc — and
   * §14.1 spends the track hues on a left-edge rule, a chip border and a
   * small mono label. All graphical objects; none of them text.
   *
   * The two golds are two roles with two floors, which a frequency reading
   * of the artboards had merged in both themes: `--color-accent-gold` is
   * `background` ×3 + `border-left` ×9, and `--color-accent-gold-text` is
   * `color` ×21-22. The second one is in the 4.5:1 group above.
   */
  for (const scheme of BOTH_SCHEMES) {
    const roles = rolesFor(scheme);
    for (const [name, role] of Object.entries(roles)) {
      if (role.kind !== 'ui') continue;
      it(`${scheme}: ${name}`, () => {
        for (const ground of role.grounds) {
          const ratio = contrastRatio(token(scheme, name), token(scheme, ground));
          expect(ratio, `${toHex(token(scheme, name))} on ${ground}`).toBeGreaterThanOrEqual(3);
        }
      });
    }
  }
});

describe('the light rail, where one token cannot satisfy both of its grounds', () => {
  /**
   * RECORDED AS ARITHMETIC, because it is arithmetic. Seven of the indicator
   * gold's nine `border-left` uses mark the current nav item on the rail,
   * whose ground is `--color-rail-bg` (#0E5457). The other two, and all
   * three `background` uses, are on the page or a card. In light mode those
   * two grounds are 8.43:1 apart, so the best contrast ANY single colour can
   * hold against both is sqrt(8.43) = 2.90:1 — under the 3:1 floor before a
   * value is even chosen. Darkening the gold to clear the page necessarily
   * costs it contrast on the rail, and vice versa.
   *
   * tokens.css resolves it toward the page and the card, because that is
   * where gold is the only signal; on the rail the current item is also
   * bold, in a different family, in a brighter text colour, on a tinted
   * background. If a future palette narrows the gap enough for one value to
   * do both, this assertion fails — and the fix then is to add
   * `--color-rail-bg` to the gold's grounds in the role table above and
   * delete this test, not to relax anything.
   */
  it('light: page and rail are too far apart for any indicator colour to clear 3:1 on both', () => {
    const spread = contrastRatio(token('light', '--color-page'), token('light', '--color-rail-bg'));
    expect(Math.sqrt(spread), 'best achievable contrast against both grounds').toBeLessThan(3);
  });

  /**
   * The companion question, settled from the artboards rather than left
   * open: light `--color-accent-gold-text` measures 1.62:1 on the rail, so
   * if it were ever used there it would be unreadable. It is not — all 22
   * `color:#8A6410` occurrences in `iPad Landscape Light` are on the page or
   * on a card (the numbered list markers, "BROWSE CATALOG →", the lesson
   * eyebrows, the streak number, the `a:hover` rule), and the rail's own
   * text is #fff and alphas of #BFE4E9. This asserts the pairing stays
   * illegal, so nobody can introduce it on the quiet belief that gold is
   * "the accent colour" and therefore fine anywhere.
   */
  it('light: gold text on the rail is not a legal pairing, and the number says why', () => {
    const ratio = contrastRatio(token('light', '--color-accent-gold-text'), token('light', '--color-rail-bg'));
    expect(ratio, 'if this ever clears 4.5, move the rail into the text role table instead').toBeLessThan(4.5);
  });
});

describe('hairlines are exempt from 1.4.11, but must still be visible', () => {
  /**
   * A divider and a heatmap cell stroke carry no information, so WCAG does
   * not put a ratio on them. A hairline nobody can see is still a bug — it
   * is the difference between a table and a wall of text — so they get a
   * perceptual floor instead of a contrast one. 0.02 ΔEok is deliberately
   * low: this is "present at all", not "prominent".
   */
  for (const scheme of BOTH_SCHEMES) {
    const roles = rolesFor(scheme);
    for (const [name, role] of Object.entries(roles)) {
      if (role.kind !== 'hairline') continue;
      it(`${scheme}: ${name}`, () => {
        for (const ground of role.grounds) {
          const worst = worstCaseDistance(token(scheme, name), token(scheme, ground));
          expect(worst.distance, `${name} against ${ground} under ${worst.vision}`).toBeGreaterThan(0.02);
        }
      });
    }
  }
});

describe('the heatmap ramp, where colour is the only signal', () => {
  /**
   * A heatmap cell is a filled square with no label on it. Nothing else says
   * how much work a day held, so every step has to be separable from its
   * neighbour — including for a dichromat. The floor is 0.04 ΔEok.
   *
   * FIVE steps, 0..4. The artboards define the ramp literally, as an array
   * of five hexes (`const steps = [...]` in both the light and dark files);
   * tokens.css used to carry six, with `--color-heat-5` surviving only as a
   * deprecated alias of `--color-heat-4` until the heatmap component moved
   * to the profile screen (Phase 4 of
   * docs/plans/2026-09-02-design-import-plan.md) and the alias retired with
   * it — see intensityLevel in src/lib/heatmap.ts.
   */
  for (const scheme of BOTH_SCHEMES) {
    it(`${scheme}: each of the five steps is distinguishable from the next, under every vision`, () => {
      for (let step = 0; step < RAMP_STEPS - 1; step += 1) {
        const worst = worstCaseDistance(
          token(scheme, `--color-heat-${step}`),
          token(scheme, `--color-heat-${step + 1}`),
        );
        expect(worst.distance, `heat-${step} to heat-${step + 1} under ${worst.vision}`).toBeGreaterThan(0.04);
      }
    });

    it(`${scheme}: the empty day is clearly not level one (design §10)`, () => {
      const empty = token(scheme, '--color-heat-0');
      const one = token(scheme, '--color-heat-1');
      // Separated on BOTH lightness and chroma, so the distinction survives a
      // greyscale print as well as colour-vision deficiency. The artboards'
      // literal light ramp failed both of these (0.0242 and 1.055): its step
      // 0 and step 1 are near-equal in lightness and differ mostly in chroma,
      // which is precisely what a protanope cannot see.
      expect(worstCaseDistance(empty, one).distance).toBeGreaterThan(0.04);
      expect(Math.abs(contrastRatio(empty, one) - 1)).toBeGreaterThan(0.15);
    });

    it(`${scheme}: an empty week is still a visible grid, not a blank page`, () => {
      /**
       * The other end of the same squeeze, and the reason the fix above is a
       * value in the middle of a narrow window rather than "make step 0
       * lighter". The grid sits directly on the page — the artboard's
       * activity block has no card behind it — so step 0 has to stay off the
       * page as well as off step 1, and it can only move toward one by
       * moving toward the other. Both ends are asserted so neither can be
       * relieved by pushing on the other.
       */
      const worst = worstCaseDistance(token(scheme, '--color-heat-0'), token(scheme, '--color-page'));
      expect(worst.distance, `the empty cell against the page under ${worst.vision}`).toBeGreaterThan(0.03);
    });
  }
});

describe('the five track hues stay apart from each other', () => {
  /**
   * THE THRESHOLD IS LOW ON PURPOSE, and the reason is worth stating: a track
   * hue never appears alone. §14.1 confines it to a chip border, a left-edge
   * rule, or a small mono label — and the chip and the label carry the
   * track's NAME. Hue is a redundant cue here, so the requirement is that two
   * tracks are not literally the same colour, not that they are
   * independently identifiable.
   *
   * The measured worst pair is teal/slate under deuteranopia, at about 0.021.
   * That is close. It is also the finding this file exists to surface, and it
   * is NOT the pair `docs/design/track-hues.md` worried about — that document
   * singles out blue-versus-slate, which measures around 0.070, more than
   * three times further apart.
   *
   * These five have no artboard source (docs/design/2026-09-02-palette.md
   * §5.1: nothing in the artboards references a track concept) and were
   * carried forward unchanged by the import, so the finding stands as it did.
   */
  for (const scheme of BOTH_SCHEMES) {
    it(`${scheme}: no two tracks collapse into the same colour, under any vision`, () => {
      for (let i = 0; i < TRACKS.length; i += 1) {
        for (let j = i + 1; j < TRACKS.length; j += 1) {
          const a = token(scheme, `--color-track-${TRACKS[i]}`);
          const b = token(scheme, `--color-track-${TRACKS[j]}`);
          const worst = worstCaseDistance(a, b);
          expect(worst.distance, `${TRACKS[i]} vs ${TRACKS[j]} under ${worst.vision}`).toBeGreaterThan(0.015);
        }
      }
    });

    it(`${scheme}: blue and slate — the pair the design doc worries about — are not the closest pair`, () => {
      const blueSlate = worstCaseDistance(
        token(scheme, '--color-track-blue'),
        token(scheme, '--color-track-slate'),
      ).distance;
      const tealSlate = worstCaseDistance(
        token(scheme, '--color-track-teal'),
        token(scheme, '--color-track-slate'),
      ).distance;

      // Recorded as an assertion rather than a comment so that if a future
      // palette change makes the documented worry the real one, someone finds
      // out here rather than by reading the doc and believing it.
      expect(tealSlate).toBeLessThan(blueSlate);
    });
  }
});
