import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/**
 * PROVES "locked badges are visibly distinct from earned ones" — Phase 4 of
 * docs/plans/2026-09-02-design-import-plan.md, measured rather than judged
 * by eye.
 *
 * The distinction badges.module.css draws is deliberately STRUCTURAL, not
 * chromatic (design §14, WCAG 1.4.1: "never by colour alone") — a solid vs.
 * dashed border and a filled vs. open seal. That is exactly what keeps this
 * test theme-independent: `border-style` and "has a fill or not" do not
 * change between light and dark, unlike the colour-mix() contrast floors
 * CLAUDE.md warns about, so there is no separate dark-mode assertion needed
 * here the way home-contrast.test.ts needs one for an alpha composite.
 *
 * This is a parse of the shipped CSS, same technique as heatmap.test.ts and
 * tokens-dark-blocks.test.ts: a hand assertion ("I looked at BadgeShelf.tsx
 * and it looks right") is exactly the kind of claim that silently rots when
 * someone edits the stylesheet next.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const CSS_PATH = path.resolve(here, '../../app/u/[handle]/badges.module.css');
// Comments stripped first: a `/* prose comment */` sitting in a rule's
// prelude (there are several here) is not a selector, but it lives in the
// same `[^{}]+` capture as one unless it is removed up front.
const css = readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Extracts the declaration block for a class selector's OWN SOLO rule —
 * `.name { ... }` — never a rule it merely shares a comma-separated prelude
 * with (`.name, .other { ... }`), which is where `.cardEarned`/`.cardLocked`
 * and `.sealEarned`/`.sealLocked` declare the properties both states share.
 * A naive "first `.name {`" match finds that shared rule for whichever name
 * comes second in the list, which is a real trap this once fell into.
 */
function ruleFor(selector: string): string {
  for (const match of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selectors = match[1]!.split(',').map((s) => s.trim());
    if (selectors.length === 1 && selectors[0] === `.${selector}`) return match[2]!;
  }
  throw new Error(`no solo rule found for .${selector} in ${CSS_PATH}`);
}

/** The `border-style` keyword a `border: <width> <style> <color>` shorthand carries. */
function borderStyleOf(rule: string): string {
  const match = rule.match(/\bborder\s*:\s*\S+\s+(solid|dashed|dotted)\b/);
  if (!match) throw new Error(`no border style found in rule: ${rule}`);
  return match[1]!;
}

/** The `background` value a rule declares, trimmed. */
function backgroundOf(rule: string): string {
  const match = rule.match(/\bbackground\s*:\s*([^;]+);/);
  if (!match) throw new Error(`no background found in rule: ${rule}`);
  return match[1]!.trim();
}

describe('badge cards: earned vs. locked is structural', () => {
  it('borders differ in STYLE (solid vs. dashed), not just colour', () => {
    const earned = borderStyleOf(ruleFor('cardEarned'));
    const locked = borderStyleOf(ruleFor('cardLocked'));
    expect(earned).toBe('solid');
    expect(locked).toBe('dashed');
    expect(earned).not.toBe(locked);
  });

  it('the seal is FILLED for earned and OPEN (transparent) for locked', () => {
    const earnedFill = backgroundOf(ruleFor('sealEarned'));
    const lockedFill = backgroundOf(ruleFor('sealLocked'));
    expect(earnedFill).not.toBe('transparent');
    expect(lockedFill).toBe('transparent');
  });

  it('the seal border also differs in style, doubling the earned/locked signal', () => {
    const earned = borderStyleOf(ruleFor('sealEarned'));
    const locked = borderStyleOf(ruleFor('sealLocked'));
    expect(earned).toBe('solid');
    expect(locked).toBe('dashed');
  });
});

describe('degree cards: the same earned/locked structure, so the two panels read as one language', () => {
  it('borders differ in style the same way the badge cards do', () => {
    const earned = borderStyleOf(ruleFor('degreeEarned'));
    const locked = borderStyleOf(ruleFor('degreeLocked'));
    expect(earned).toBe('solid');
    expect(locked).toBe('dashed');
  });
});
