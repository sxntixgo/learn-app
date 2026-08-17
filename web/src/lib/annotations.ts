/*
 * Line-anchored annotations: the pure half of the annotatable `code` block
 * (design §9.4, §14.1/§14.2). Everything here is data — no React, no DOM —
 * so the interaction design in AnnotatableCode.tsx is a thin shell over
 * logic that is unit-tested on its own.
 *
 * Two rules drive the shapes below.
 *
 * 1. **An anchor is a line RANGE, 1-indexed and inclusive.** A single-line
 *    annotation is a range of one. The content model (schemas/blocks.schema
 *    .json) writes those two cases as `line` and `lines: [start, end]`;
 *    `fromAuthorAnnotations` collapses both into one internal shape so the
 *    component never branches on it.
 *
 * 2. **Anchors are validated against the code they were given, and an anchor
 *    that does not fit is never silently moved.** Design §9.4 is explicit
 *    that a submission snapshots the block and annotations anchor to the
 *    snapshot, precisely so "line 14" cannot drift. `partitionAnnotations`
 *    therefore hands back an `orphaned` list for the caller to show rather
 *    than clamping the range into something that reads plausibly and is
 *    wrong.
 */

export interface LineRange {
  /** First line of the anchor, 1-indexed, inclusive. */
  start: number;
  /** Last line of the anchor, 1-indexed, inclusive. `end >= start`. */
  end: number;
}

export interface Annotation {
  id: string;
  range: LineRange;
  body: string;
  /**
   * `author` annotations come from the content repo and are read-only
   * everywhere (design §9.4: "in a lesson it carries author annotations,
   * read-only"). `student` annotations are the ones this component's user
   * writes. Editing and deleting check this, not the UI mode, so a stray
   * call cannot rewrite content.
   */
  origin: 'author' | 'student';
  /** Optional track id (design §6.1), rendered as a structural left rule only. */
  track?: string;
  /** ISO timestamp, used only for stable ordering of same-anchor annotations. */
  createdAt?: string;
}

/** The content-model shape, from schemas/blocks.schema.json's `annotation`. */
export interface AuthorAnnotationInput {
  line?: number;
  lines?: number[];
  track?: string;
  body: string;
}

export interface HighlightedCode {
  /** Custom properties lifted off shiki's `<pre>` (its dual-theme variables). */
  style: Record<string, string>;
  /** Inner HTML of each `<span class="line">`, one entry per source line. */
  lines: string[];
}

const LINE_SPAN_START = /<span class="line[^"]*">/g;

/**
 * Splits shiki's rendered block into per-line HTML so each line can carry its
 * own anchor element.
 *
 * Shiki gives us one `<pre><code>` with `<span class="line">…</span>`
 * children separated by newlines, and we need per-line DOM nodes to hang a
 * gutter control off. Re-highlighting line by line would be wrong (a
 * multi-line string or comment loses its state), so we highlight the whole
 * block exactly as before — CLAUDE.md rule 4, at render time — and split the
 * output.
 *
 * The scan tracks `<span>` nesting rather than regex-matching the closing
 * tag, because a line's own content is spans all the way down.
 */
export function splitHighlightedLines(html: string): HighlightedCode {
  const style = parseStyleAttribute(/<pre[^>]*\sstyle="([^"]*)"/.exec(html)?.[1] ?? '');
  const lines: string[] = [];

  LINE_SPAN_START.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LINE_SPAN_START.exec(html)) !== null) {
    const from = match.index + match[0].length;
    const end = findSpanEnd(html, from);
    if (end === -1) break;
    lines.push(html.slice(from, end));
    LINE_SPAN_START.lastIndex = end;
  }

  // A source ending in a newline makes shiki emit a final empty line span
  // that is not a line of the file. Dropping it keeps `lines.length` equal
  // to `source.split('\n').length` for the source the author wrote, which is
  // what every line number in an annotation refers to.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();

  return { style, lines: lines.length > 0 ? lines : [''] };
}

/** Index of the `</span>` that closes the span opened just before `from`. */
function findSpanEnd(html: string, from: number): number {
  let depth = 0;
  let index = from;
  while (index < html.length) {
    const next = html.indexOf('<', index);
    if (next === -1) return -1;
    if (html.startsWith('</span>', next)) {
      if (depth === 0) return next;
      depth -= 1;
      index = next + '</span>'.length;
      continue;
    }
    if (html.startsWith('<span', next)) depth += 1;
    index = next + 1;
  }
  return -1;
}

/**
 * Turns an inline `style` attribute into the object React wants. Only used
 * on shiki's own output, which is why it is deliberately simple: first colon
 * splits, everything after it is the value (URLs contain colons).
 */
export function parseStyleAttribute(style: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const declaration of style.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon <= 0) continue;
    const property = declaration.slice(0, colon).trim();
    const value = declaration.slice(colon + 1).trim();
    if (property && value) out[property] = value;
  }
  return out;
}

function isLineNumber(value: number): boolean {
  return Number.isInteger(value) && value >= 1;
}

/**
 * Orders and clamps a pair of line numbers into a usable range, or returns
 * null when there is nothing sensible to return. Used for *selection*, where
 * clamping is the friendly behaviour — dragging past the last line should
 * stop at the last line. Stored anchors go through `isValidAnchor` instead,
 * which never clamps.
 */
export function normalizeRange(a: number, b: number, lineCount: number): LineRange | null {
  if (!isLineNumber(lineCount)) return null;
  if (!Number.isInteger(a) || !Number.isInteger(b)) return null;

  const low = Math.min(a, b);
  const high = Math.max(a, b);
  if (high < 1 || low > lineCount) return null;

  return { start: Math.max(1, low), end: Math.min(lineCount, high) };
}

/** True when the range lands wholly inside code of `lineCount` lines. */
export function isValidAnchor(range: LineRange, lineCount: number): boolean {
  return (
    isLineNumber(range.start) &&
    isLineNumber(range.end) &&
    range.start <= range.end &&
    range.end <= lineCount
  );
}

/**
 * Splits a list into the annotations that still anchor to this code and the
 * ones that no longer do. The orphans are returned, not dropped: losing a
 * student's comment because a line vanished is the failure design §9.4 calls
 * out, and the component shows them in a separate list.
 */
export function partitionAnnotations(
  annotations: readonly Annotation[],
  lineCount: number
): { anchored: Annotation[]; orphaned: Annotation[] } {
  const anchored: Annotation[] = [];
  const orphaned: Annotation[] = [];
  for (const annotation of sortAnnotations(annotations)) {
    (isValidAnchor(annotation.range, lineCount) ? anchored : orphaned).push(annotation);
  }
  return { anchored, orphaned };
}

/**
 * Reading order: down the file, and for one line the narrowest anchor first
 * (the note about *this* line before the note about the block it sits in),
 * then oldest first, then by id so the order is total and stable.
 */
export function sortAnnotations(annotations: readonly Annotation[]): Annotation[] {
  return [...annotations].sort(
    (a, b) =>
      a.range.start - b.range.start ||
      a.range.end - b.range.end ||
      (a.createdAt ?? '').localeCompare(b.createdAt ?? '') ||
      a.id.localeCompare(b.id)
  );
}

/** Every annotation whose range covers this line, overlaps included. */
export function annotationsCoveringLine(annotations: readonly Annotation[], line: number): Annotation[] {
  return sortAnnotations(annotations.filter((a) => a.range.start <= line && line <= a.range.end));
}

/**
 * Files each annotation under the LAST line of its range, which is where the
 * component renders its card: you read the passage, then the comment on it —
 * the order a code review is read in.
 */
export function groupAnnotationsByEndLine(annotations: readonly Annotation[]): Map<number, Annotation[]> {
  const grouped = new Map<number, Annotation[]>();
  for (const annotation of sortAnnotations(annotations)) {
    const bucket = grouped.get(annotation.range.end);
    if (bucket) bucket.push(annotation);
    else grouped.set(annotation.range.end, [annotation]);
  }
  return grouped;
}

/** Visible label, e.g. "Line 12" / "Lines 12–14" (en dash, as a label). */
export function formatRangeLabel(range: LineRange): string {
  return range.start === range.end ? `Line ${range.start}` : `Lines ${range.start}–${range.end}`;
}

/** Spoken form, e.g. "lines 12 to 14" — an en dash is not read as a range. */
export function describeRange(range: LineRange): string {
  return range.start === range.end ? `line ${range.start}` : `lines ${range.start} to ${range.end}`;
}

/**
 * Accessible name for a line's control. The annotation count is in the NAME
 * rather than left to a colour or a marker glyph, so "this line has comments
 * on it" survives a screen reader (design §14.2).
 */
export function describeLine(line: number, annotationCount: number, lineCount: number): string {
  const notes =
    annotationCount === 0
      ? 'no annotations'
      : `${annotationCount} annotation${annotationCount === 1 ? '' : 's'}`;
  return `Line ${line} of ${lineCount}, ${notes}`;
}

/**
 * Converts content-repo annotations into the internal shape, dropping any
 * that do not anchor to this code rather than guessing where they meant.
 * Ids are positional and therefore stable for a given input.
 */
export function fromAuthorAnnotations(
  inputs: readonly AuthorAnnotationInput[],
  lineCount: number
): Annotation[] {
  const converted: Annotation[] = [];

  inputs.forEach((input, index) => {
    const body = input.body?.trim() ?? '';
    if (!body) return;

    let range: LineRange | null = null;
    if (typeof input.line === 'number') {
      range = { start: input.line, end: input.line };
    } else if (Array.isArray(input.lines) && input.lines.length === 2) {
      const [start, end] = input.lines as [number, number];
      range = { start, end };
    }
    if (!range || !isValidAnchor(range, lineCount)) return;

    converted.push({
      id: `author-${index}`,
      range,
      body,
      origin: 'author',
      ...(input.track ? { track: input.track } : {}),
    });
  });

  return sortAnnotations(converted);
}

export interface NewAnnotation {
  id: string;
  range: LineRange;
  body: string;
  track?: string;
  createdAt?: string;
}

/**
 * Adds a student annotation. Returns the SAME array reference when the input
 * is refused, so a caller can treat identity as "nothing changed".
 */
export function addAnnotation(annotations: readonly Annotation[], next: NewAnnotation): Annotation[] {
  const body = next.body.trim();
  if (!body) return annotations as Annotation[];
  if (annotations.some((a) => a.id === next.id)) return annotations as Annotation[];

  return sortAnnotations([
    ...annotations,
    {
      id: next.id,
      range: next.range,
      body,
      origin: 'student',
      ...(next.track ? { track: next.track } : {}),
      ...(next.createdAt ? { createdAt: next.createdAt } : {}),
    },
  ]);
}

/** Edits a body in place. The anchor is never touched, and author annotations are refused. */
export function updateAnnotation(
  annotations: readonly Annotation[],
  id: string,
  body: string
): Annotation[] {
  const trimmed = body.trim();
  const target = annotations.find((a) => a.id === id);
  if (!trimmed || !target || target.origin === 'author') return annotations as Annotation[];

  return annotations.map((a) => (a.id === id ? { ...a, body: trimmed } : a));
}

/** Deletes a student annotation. Author annotations are refused. */
export function removeAnnotation(annotations: readonly Annotation[], id: string): Annotation[] {
  const target = annotations.find((a) => a.id === id);
  if (!target || target.origin === 'author') return annotations as Annotation[];

  return annotations.filter((a) => a.id !== id);
}

/** Collapses the selection onto one line, clamped into the code. */
export function selectLine(line: number, lineCount: number): LineRange | null {
  if (!isLineNumber(lineCount) || !Number.isInteger(line)) return null;
  const clamped = clampLine(line, lineCount);
  return { start: clamped, end: clamped };
}

/**
 * Moves the START of the selection by `delta` lines. Never crosses the end,
 * so the range cannot invert; a step that would is simply refused. This is
 * what the "first line" stepper pair and Shift+ArrowUp both call.
 */
export function adjustRangeStart(range: LineRange, delta: number, lineCount: number): LineRange {
  const start = Math.min(Math.max(1, range.start + delta), Math.min(range.end, lineCount));
  return start === range.start ? range : { start, end: range.end };
}

/** Moves the END of the selection by `delta` lines. Never crosses the start. */
export function adjustRangeEnd(range: LineRange, delta: number, lineCount: number): LineRange {
  const end = Math.max(Math.min(lineCount, range.end + delta), range.start);
  return end === range.end ? range : { start: range.start, end };
}

/** Keeps a focused line inside the code. */
export function clampLine(line: number, lineCount: number): number {
  return Math.min(Math.max(1, line), Math.max(1, lineCount));
}
