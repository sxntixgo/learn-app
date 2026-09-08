import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/**
 * KITCHEN-SINK TOKEN COVERAGE (plan Phase 1, task 8).
 *
 * `/kitchen-sink` is Gate 1: the page a human opens at 375 / 834 / 1194 /
 * 1440 in both themes to judge the imported palette and type against the
 * artboards. That only works if the page shows EVERY token — so a token
 * added to tokens.css without a swatch has to fail here rather than quietly
 * going unreviewed.
 *
 * Lives beside palette.test.ts and tokens-dark-blocks.test.ts, the two other
 * files that parse tokens.css, and follows their approach rather than adding
 * a third way of doing the same thing.
 *
 * COMMENTS ARE STRIPPED FROM BOTH SIDES, and that is the whole subtlety of
 * this file. On the tokens.css side, a token name quoted inside one of that
 * file's many explanatory comments is not a declaration. On the page side, a
 * token merely MENTIONED in a comment is not a swatch — without stripping,
 * writing `// TODO: --color-foo` would satisfy the coverage assertion while
 * showing the reviewer nothing. Same class of vacuity as the "token file
 * parses at all" guard in palette.test.ts, from the opposite direction.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_CSS = path.resolve(here, '../../app/tokens.css');
const PAGE_TSX = path.resolve(here, '../../app/kitchen-sink/page.tsx');

/** Block comments, plus whole lines that are `//` or ` *` continuations. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*');
    })
    .join('\n');
}

/** Every custom property tokens.css actually DECLARES (`--name:`). */
function declaredTokens(css: string): Set<string> {
  const found = new Set<string>();
  for (const match of stripComments(css).matchAll(/(--[a-z][a-z0-9-]*)\s*:/g)) {
    found.add(match[1]!);
  }
  return found;
}

/** Every token the page REFERENCES, once its comments are discounted. */
function tokensOnPage(source: string): Set<string> {
  const found = new Set<string>();
  for (const match of stripComments(source).matchAll(/(--[a-z][a-z0-9-]*)/g)) {
    found.add(match[1]!);
  }
  return found;
}

describe('the kitchen-sink page covers every token', () => {
  const declared = declaredTokens(readFileSync(TOKENS_CSS, 'utf8'));
  const onPage = tokensOnPage(readFileSync(PAGE_TSX, 'utf8'));

  // Vacuity guard, same purpose as palette.test.ts's parse check: if either
  // regex stops matching, every assertion below passes by finding nothing.
  //
  // The floor is deliberately well below the real count rather than just
  // under it. It exists to catch a regex that matches NOTHING, not to pin the
  // palette's size — and a floor set just under the current total has to be
  // edited every time a deprecated alias retires, which is a change with no
  // information in it. It was 50 and tripped at 49 when --color-accent-yellow
  // and the three --color-banner-* aliases went; that was the guard being
  // brittle, not a real finding.
  it('finds a realistic number of tokens on both sides', () => {
    expect(declared.size).toBeGreaterThan(40);
    expect(onPage.size).toBeGreaterThan(40);
  });

  it('shows every token declared in tokens.css', () => {
    const missing = [...declared].filter((token) => !onPage.has(token)).sort();
    expect(missing, 'declared in tokens.css but absent from /kitchen-sink').toEqual([]);
  });

  /*
   * The bite, asserted rather than described. This used to be an `it.skip`
   * carrying manual instructions, which is documentation wearing a test's
   * clothing — it can never fail, so it proves nothing on any run but the
   * one where somebody followed the steps by hand.
   */
  it('fails when a token is declared but has no swatch', () => {
    const css = readFileSync(TOKENS_CSS, 'utf8');
    const withExtra = declaredTokens(`${css}\n:root { --color-not-on-the-page: oklch(0.5 0 0); }`);

    expect(withExtra.has('--color-not-on-the-page')).toBe(true);
    expect([...withExtra].filter((token) => !onPage.has(token))).toEqual([
      '--color-not-on-the-page',
    ]);
  });

  it('does not count a token that the page only mentions in a comment', () => {
    const commentOnly = tokensOnPage('// TODO: add a swatch for --color-mentioned-only\n');
    expect(commentOnly.has('--color-mentioned-only')).toBe(false);
  });
});
