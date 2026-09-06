import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/**
 * app/tokens.css declares dark mode TWICE — once inside the guarded
 * `@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) {…} }`
 * block, and once again, unconditionally, in `:root[data-theme='dark'] {…}`
 * — because a plain CSS custom-property file has no mixin to share values
 * from (see the file's own header and the comment above the second block).
 *
 * That duplication is deliberate, but it means nothing stops the two from
 * drifting the next time someone tweaks a dark value in one block and
 * forgets the other. This file is that guard: it parses both blocks out of
 * the real tokens.css and asserts they declare the same set of custom
 * properties with the same values, so a drift fails loudly here instead of
 * shipping as a theme that is dark in one code path and not the other.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const tokensCssPath = path.resolve(here, '../../app/tokens.css');
const tokensCss = readFileSync(tokensCssPath, 'utf8');

/** Strips /* … *\/ comments so a comment mentioning "--foo: bar;" can't be mistaken for a declaration. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Extracts every `--name: value;` custom-property declaration from a CSS source slice. */
function parseDeclarations(source: string): Map<string, string> {
  const declarations = new Map<string, string>();
  for (const match of stripComments(source).matchAll(/(--[a-z][a-z0-9-]*)\s*:\s*([^;]+?)\s*;/g)) {
    declarations.set(match[1]!, match[2]!.trim());
  }
  return declarations;
}

/**
 * Slices out one top-level `{ … }` block, starting at the FIRST `{` at or
 * after `searchFrom`, and returns [blockBody, indexAfterClosingBrace] — a
 * small brace-matcher rather than a regex, so nested rules (the media
 * query wrapping `:root:not(...)`) don't confuse it.
 */
function sliceBlock(source: string, searchFrom: number): { body: string; end: number } {
  const openIndex = source.indexOf('{', searchFrom);
  if (openIndex === -1) throw new Error(`no "{" found searching from index ${searchFrom}`);
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return { body: source.slice(openIndex + 1, i), end: i + 1 };
    }
  }
  throw new Error(`unbalanced braces searching from index ${openIndex}`);
}

const MEDIA_QUERY_MARKER = '@media (prefers-color-scheme: dark)';
const DATA_THEME_MARKER = "[data-theme='dark']";

const mediaQueryStart = tokensCss.indexOf(MEDIA_QUERY_MARKER);
const dataThemeStart = tokensCss.indexOf(DATA_THEME_MARKER, mediaQueryStart + MEDIA_QUERY_MARKER.length);

describe('tokens.css: the two dark blocks stay in sync', () => {
  it('both dark blocks are present, in the expected order', () => {
    expect(mediaQueryStart, `"${MEDIA_QUERY_MARKER}" not found in tokens.css`).toBeGreaterThan(0);
    expect(
      dataThemeStart,
      `"${DATA_THEME_MARKER}" not found (as the unconditional block) after the media query`,
    ).toBeGreaterThan(mediaQueryStart);
  });

  // The media query wraps a nested `:root:not(...) { … }` rule; sliceBlock's
  // brace matching means we can hand it the whole media-query body and it
  // still finds the right, single, top-level block inside it.
  const mediaQueryBlock = sliceBlock(tokensCss, mediaQueryStart);
  const nestedRootBlock = sliceBlock(mediaQueryBlock.body, 0);
  const dataThemeBlock = sliceBlock(tokensCss, dataThemeStart);

  const guarded = parseDeclarations(nestedRootBlock.body);
  const unconditional = parseDeclarations(dataThemeBlock.body);

  it('each block actually declares a non-trivial number of tokens', () => {
    // Vacuous otherwise: an empty pair of maps trivially has "the same keys".
    expect(guarded.size).toBeGreaterThan(20);
    expect(unconditional.size).toBeGreaterThan(20);
  });

  it('declares exactly the same set of custom properties in both blocks', () => {
    const guardedNames = [...guarded.keys()].sort();
    const unconditionalNames = [...unconditional.keys()].sort();
    expect(unconditionalNames).toEqual(guardedNames);
  });

  it('declares an identical value for every custom property in both blocks', () => {
    const mismatches: string[] = [];
    for (const [name, guardedValue] of guarded) {
      const unconditionalValue = unconditional.get(name);
      if (unconditionalValue !== guardedValue) {
        mismatches.push(`${name}: guarded="${guardedValue}" unconditional="${unconditionalValue}"`);
      }
    }
    expect(mismatches, mismatches.join('\n')).toEqual([]);
  });
});

/**
 * Measure tokens — prose measure must be constant across breakpoints.
 *
 * design §14.2 requires the reading column's prose measure (`--measure-prose`)
 * to be constant across all breakpoints: the chrome and breakout blocks adapt
 * instead. The only way to ensure this is to declare it once, outside any
 * @media block, so it can never be accidentally overridden.
 *
 * The other measure tokens (`--measure-breakout`, `--measure-full`) are
 * allowed to step at density breakpoints (834px and 1440px), but
 * `--measure-prose` must appear exactly once in the root declaration.
 */
describe('tokens.css: measure tokens', () => {
  it('--measure-prose is declared exactly once, outside any @media block', () => {
    // Extract the root block that precedes all @media queries
    const firstMediaIndex = tokensCss.indexOf('@media');
    if (firstMediaIndex === -1) {
      throw new Error('no @media block found in tokens.css');
    }

    // Find the :root block before the first @media
    const rootStart = tokensCss.lastIndexOf(':root', firstMediaIndex);
    if (rootStart === -1) {
      throw new Error('no :root block found before first @media in tokens.css');
    }

    const rootBlock = sliceBlock(tokensCss, rootStart);
    const rootDeclarations = parseDeclarations(rootBlock.body);

    // Verify --measure-prose exists in the root
    const proseValue = rootDeclarations.get('--measure-prose');
    expect(proseValue, '--measure-prose not found in root block').toBeDefined();
    // 60ch — re-derived 2026-09-03 so the rendered column lands on the
    // reader artboards' drawn 600px at their 19px Source Serif 4 reading
    // size (measured in a real browser: 1ch = 10px at that font/size, see
    // tokens.css's own comment above this token).
    expect(proseValue).toBe('60ch');

    // Count occurrences of --measure-prose in the entire CSS file (outside comments)
    const withoutComments = stripComments(tokensCss);
    const matches = [...withoutComments.matchAll(/--measure-prose\s*:/g)];

    expect(
      matches.length,
      `--measure-prose should be declared exactly once, but found ${matches.length} declarations`,
    ).toBe(1);

    // Verify that the single declaration is NOT inside any @media block
    // by checking that there is no @media before the match position
    const matchPosition = matches[0]!.index!;
    const beforeMatch = withoutComments.slice(0, matchPosition);
    const openMediaCount = (beforeMatch.match(/@media/g) || []).length;
    const closeMediaCount = (beforeMatch.match(/^\s*}/gm) || []).length;

    expect(
      openMediaCount,
      'the --measure-prose declaration should not be inside any @media block',
    ).toBe(closeMediaCount);
  });

  it('--measure-breakout and --measure-full change at the 834 and 1440 breakpoints', () => {
    // Extract the three density blocks: root (default), @media (min-width: 834px), @media (min-width: 1440px)
    const measurements: Record<string, Map<string, string>> = {};

    // Root block
    const firstMediaIndex = tokensCss.indexOf('@media');
    const rootStart = tokensCss.lastIndexOf(':root', firstMediaIndex);
    const rootBlock = sliceBlock(tokensCss, rootStart);
    measurements.root = parseDeclarations(rootBlock.body);

    // 834px block
    const mediaIndex834 = tokensCss.indexOf('@media (min-width: 834px)');
    if (mediaIndex834 === -1) {
      throw new Error('@media (min-width: 834px) not found');
    }
    const block834 = sliceBlock(tokensCss, mediaIndex834);
    measurements['834px'] = parseDeclarations(block834.body);

    // 1440px block
    const mediaIndex1440 = tokensCss.indexOf('@media (min-width: 1440px)');
    if (mediaIndex1440 === -1) {
      throw new Error('@media (min-width: 1440px) not found');
    }
    const block1440 = sliceBlock(tokensCss, mediaIndex1440);
    measurements['1440px'] = parseDeclarations(block1440.body);

    // Verify breakout changes
    expect(measurements.root.get('--measure-breakout')).toBe('70ch');
    expect(measurements['834px'].get('--measure-breakout')).toBe('84ch');
    expect(measurements['1440px'].get('--measure-breakout')).toBe('100ch');

    // Verify full changes
    expect(measurements.root.get('--measure-full')).toBe('76ch');
    expect(measurements['834px'].get('--measure-full')).toBe('90ch');
    expect(measurements['1440px'].get('--measure-full')).toBe('100ch');

    // Verify prose stays constant (not present in the media blocks)
    expect(measurements['834px'].get('--measure-prose')).toBeUndefined();
    expect(measurements['1440px'].get('--measure-prose')).toBeUndefined();
  });
});
