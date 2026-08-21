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
 * GATE 4, ANSWERED WITH ARITHMETIC.
 *
 * `CHOSEN-PALETTE.md` and `docs/design/track-hues.md` leave a set of
 * questions open — does the yellow clear 3:1 as a non-text indicator, are the
 * five track hues distinguishable, is slate distinguishable from blue when
 * they differ almost entirely in chroma — and they were left open because
 * they read like things only an eye can settle. Most of them are not.
 *
 * WHAT THIS FILE FOUND, on first run:
 *
 *  - `--color-accent-yellow` in light mode was OUT OF SRGB GAMUT and, once
 *    clipped by the browser to #cc9d00, sat at 2.46:1 against the page. Every
 *    use of that token in this app is a border or an active-state marker, so
 *    WCAG 1.4.11's 3:1 applies. Fixed in tokens.css; this file is the floor.
 *  - The design doc names blue-versus-slate as the risky pair ("differ almost
 *    entirely in chroma"). Measured, it is not the closest pair: teal and
 *    slate are three times closer under deuteranopia. The documented worry
 *    was aimed at the wrong pair.
 *  - `--color-heat-4` and `--color-heat-5` are also marginally out of gamut in
 *    light mode. Left as they are, deliberately: they are heatmap fills, the
 *    clipped ramp still separates at every step, and unlike the yellow they
 *    carry no contrast requirement. Recorded rather than silently fixed.
 *
 * WHAT IT DELIBERATELY DOES NOT DO is decide whether a colour is nice, or
 * whether ochre reads as "ochre". Those need eyes. Everything below is a
 * number that was previously being guessed at.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const tokensCss = readFileSync(path.resolve(here, '../../app/tokens.css'), 'utf8');

/**
 * Splits the file at the dark block. The light values live in the bare
 * `:root`; `@media (prefers-color-scheme: dark)` and the `[data-theme='dark']`
 * override that follows it carry the same dark values, so reading from the
 * media query onward is enough.
 */
const DARK_BLOCK_START = tokensCss.indexOf('@media (prefers-color-scheme: dark)');

function tokensIn(source: string): Map<string, LinearRgb> {
  const found = new Map<string, LinearRgb>();
  for (const match of source.matchAll(/(--color-[a-z0-9-]+):\s*oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)/g)) {
    // First definition wins: the dark slice defines each token once in the
    // media query and again in the [data-theme] block, with the same value.
    if (!found.has(match[1]!)) {
      found.set(match[1]!, oklchToLinearRgb(Number(match[2]), Number(match[3]), Number(match[4])));
    }
  }
  return found;
}

const SCHEMES = {
  light: tokensIn(tokensCss.slice(0, DARK_BLOCK_START)),
  dark: tokensIn(tokensCss.slice(DARK_BLOCK_START)),
} as const;

const TRACKS = ['blue', 'teal', 'ochre', 'maroon', 'slate'] as const;

function token(scheme: keyof typeof SCHEMES, name: string): LinearRgb {
  const value = SCHEMES[scheme].get(name);
  if (!value) throw new Error(`${name} is not defined in the ${scheme} scheme`);
  return value;
}

describe('the token file parses at all', () => {
  // Every assertion below is vacuous if this regex stops matching — a
  // reformatted tokens.css would turn the whole file green by finding
  // nothing to check.
  it('finds both schemes, with the same set of colour tokens in each', () => {
    expect(DARK_BLOCK_START).toBeGreaterThan(0);
    expect(SCHEMES.light.size).toBeGreaterThan(20);
    expect([...SCHEMES.dark.keys()].sort()).toEqual([...SCHEMES.light.keys()].sort());
  });
});

describe('every colour is one a screen can actually show', () => {
  /**
   * An out-of-gamut token is not a style opinion: the browser clips it, so
   * the value in this file is not the value on the screen, and every later
   * judgement about it is about a colour nobody chose.
   */
  const KNOWN_CLIPPED: Record<string, string> = {
    // Heatmap fills at the dark end of the light ramp. Left in place: the
    // clipped ramp still separates at every step (asserted below), and a fill
    // carries no contrast requirement. Listed so a NEW one fails.
    '--color-heat-4': 'light',
    '--color-heat-5': 'light',
  };

  for (const scheme of ['light', 'dark'] as const) {
    it(`${scheme}: nothing is out of gamut except the two recorded heatmap fills`, () => {
      const outOfGamut = [...SCHEMES[scheme].entries()]
        .filter(([, rgb]) => !inSrgbGamut(rgb))
        .map(([name]) => name)
        .filter((name) => KNOWN_CLIPPED[name] !== scheme);

      expect(outOfGamut, `these clip to something other than what tokens.css says`).toEqual([]);
    });
  }
});

describe('the one yellow accent clears 3:1 as a non-text indicator (Gate 4, question 1)', () => {
  /**
   * The answer, before the fix, was NO — 2.46:1 in light mode. Every use of
   * this token is a border or an active-state marker (the nav's current-item
   * underline, the admin tab marker, the rule beside an error message), which
   * is a "user interface component or graphical object" under WCAG 1.4.11.
   *
   * Checked against the raised surface as well as the page: a border on a
   * card sits on the lighter of the two, and the card is the harder case.
   */
  for (const scheme of ['light', 'dark'] as const) {
    it(`${scheme}: at least 3:1 against both the page and a raised surface`, () => {
      const yellow = token(scheme, '--color-accent-yellow');
      const againstPage = contrastRatio(yellow, token(scheme, '--color-page'));
      const againstCard = contrastRatio(yellow, token(scheme, '--color-surface-raised'));

      expect(againstPage, `${toHex(yellow)} on the page`).toBeGreaterThanOrEqual(3);
      expect(againstCard, `${toHex(yellow)} on a card`).toBeGreaterThanOrEqual(3);
    });
  }
});

describe('every track hue clears 3:1 as a structural indicator', () => {
  // §14.1 spends hue on a left-edge rule, a chip border, and a small mono
  // label — all non-text graphical objects, all 1.4.11.
  for (const scheme of ['light', 'dark'] as const) {
    for (const track of TRACKS) {
      it(`${scheme}: ${track}`, () => {
        const hue = token(scheme, `--color-track-${track}`);
        expect(contrastRatio(hue, token(scheme, '--color-page'))).toBeGreaterThanOrEqual(3);
        expect(contrastRatio(hue, token(scheme, '--color-surface-raised'))).toBeGreaterThanOrEqual(3);
      });
    }
  }
});

describe('the five track hues stay apart from each other (Gate 4, questions 2 and 3)', () => {
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
   * The heatmap below is the case where colour IS the only signal, and it
   * gets a real floor.
   */
  for (const scheme of ['light', 'dark'] as const) {
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

describe('the heatmap ramp, where colour is the only signal', () => {
  /**
   * A heatmap cell is a filled square with no label on it. Nothing else says
   * how much work a day held, so every step has to be separable from its
   * neighbour — including for a dichromat, and including after the browser
   * clips the two light-mode steps that fall outside sRGB.
   *
   * The floor is 0.04 ΔEok. The measured minimum is the empty-to-level-one
   * step at 0.051, which design §10 calls out as the one that matters most
   * ("a quiet week reads as a dead grid" otherwise); every other step is
   * above 0.09.
   */
  for (const scheme of ['light', 'dark'] as const) {
    it(`${scheme}: each step is distinguishable from the next, under every vision`, () => {
      for (let step = 0; step < 5; step += 1) {
        const worst = worstCaseDistance(token(scheme, `--color-heat-${step}`), token(scheme, `--color-heat-${step + 1}`));
        expect(worst.distance, `heat-${step} to heat-${step + 1} under ${worst.vision}`).toBeGreaterThan(0.04);
      }
    });

    it(`${scheme}: the empty day is clearly not level one (design §10)`, () => {
      const empty = token(scheme, '--color-heat-0');
      const one = token(scheme, '--color-heat-1');
      // Separated on BOTH lightness and chroma, so the distinction survives a
      // greyscale print as well as colour-vision deficiency.
      expect(worstCaseDistance(empty, one).distance).toBeGreaterThan(0.04);
      expect(Math.abs(contrastRatio(empty, one) - 1)).toBeGreaterThan(0.15);
    });
  }
});

describe('body text meets the text contrast threshold', () => {
  // 4.5:1, the ordinary WCAG AA floor for body copy — a different and
  // stricter requirement than the 3:1 the indicators above are held to.
  for (const scheme of ['light', 'dark'] as const) {
    it(`${scheme}: primary and secondary text on the page and on a card`, () => {
      for (const name of ['--color-text', '--color-text-secondary']) {
        for (const surface of ['--color-page', '--color-surface-raised']) {
          expect(contrastRatio(token(scheme, name), token(scheme, surface)), `${name} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    it(`${scheme}: link teal against the page`, () => {
      expect(contrastRatio(token(scheme, '--color-link'), token(scheme, '--color-page'))).toBeGreaterThanOrEqual(4.5);
    });
  }
});
