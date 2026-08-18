/*
 * Shared shiki setup for every reader that renders `code` blocks — the
 * lesson page and the grading view both highlight a block list at render
 * time (CLAUDE.md rule 4: syntax highlighting happens at render, never at
 * import time) using the exact same theme pair, so this is the one place
 * that pairing is declared rather than copied.
 */

import { codeToHtml } from 'shiki';

// One dual-theme pair covers both colour schemes — see the shiki rules in
// app/globals.css that decide which half paints, driven by
// prefers-color-scheme (no JS theme switcher; that's Phase 4).
export const CODE_THEMES = { light: 'github-light', dark: 'github-dark-dimmed' } as const;

export interface HighlightableCodeBlock {
  lang?: string | null;
  source: string;
}

/**
 * Highlights one `code` block. A language shiki doesn't recognise falls
 * back to plain text rather than failing the whole page — a course author's
 * typo in a fence's language tag must not 500 the reader.
 */
export async function highlightCode(block: HighlightableCodeBlock): Promise<string> {
  const lang = block.lang ?? 'text';
  try {
    return await codeToHtml(block.source, { lang, themes: CODE_THEMES, defaultColor: false });
  } catch {
    return await codeToHtml(block.source, { lang: 'text', themes: CODE_THEMES, defaultColor: false });
  }
}

/** Highlights every `code` block in a list, keyed by its index into the list — the shape both readers pass to AnnotatableCode. */
export async function highlightCodeBlocks<T extends { type: string }>(
  blocks: readonly T[],
  isCode: (block: T) => block is T & HighlightableCodeBlock,
): Promise<Record<number, string>> {
  const codeIndexes = blocks
    .map((block, index) => ({ block, index }))
    .filter((entry): entry is { block: T & HighlightableCodeBlock; index: number } => isCode(entry.block));

  const entries = await Promise.all(
    codeIndexes.map(async ({ block, index }) => [index, await highlightCode(block)] as const),
  );
  return Object.fromEntries(entries);
}
