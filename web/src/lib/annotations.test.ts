import { describe, expect, it } from 'vitest';
import { codeToHtml } from 'shiki';
import {
  addAnnotation,
  adjustRangeEnd,
  adjustRangeStart,
  annotationsCoveringLine,
  clampLine,
  describeLine,
  describeRange,
  formatRangeLabel,
  fromAuthorAnnotations,
  fromSubmissionAnnotations,
  groupAnnotationsByEndLine,
  isValidAnchor,
  normalizeRange,
  parseStyleAttribute,
  partitionAnnotations,
  removeAnnotation,
  selectLine,
  sortAnnotations,
  splitHighlightedLines,
  toSubmissionAnnotationInputs,
  updateAnnotation,
  type Annotation,
  type SubmissionAnnotationWire,
} from './annotations';

function student(id: string, start: number, end: number, body = 'note', createdAt?: string): Annotation {
  return { id, range: { start, end }, body, origin: 'student', ...(createdAt ? { createdAt } : {}) };
}

describe('splitHighlightedLines', () => {
  it('splits real shiki dual-theme output into one entry per source line', async () => {
    const source = 'function f(a) {\n\n  return a; // note\n}';
    const html = await codeToHtml(source, {
      lang: 'ts',
      themes: { light: 'github-light', dark: 'github-dark-dimmed' },
      defaultColor: false,
    });

    const split = splitHighlightedLines(html);

    expect(split.lines).toHaveLength(source.split('\n').length);
    // Line 1 keeps its nested highlight spans intact.
    expect(split.lines[0]).toContain('function');
    expect(split.lines[0]).toContain('<span style=');
    // Line 2 is genuinely empty and must survive as an empty string, not vanish.
    expect(split.lines[1]).toBe('');
    expect(split.lines[2]).toContain('// note');
    expect(split.lines[3]).toContain('}');
  });

  it('drops the phantom trailing line shiki emits for a source ending in a newline', async () => {
    const source = 'const a = 1;\n';
    const html = await codeToHtml(source, {
      lang: 'ts',
      themes: { light: 'github-light', dark: 'github-dark-dimmed' },
      defaultColor: false,
    });

    expect(splitHighlightedLines(html).lines).toHaveLength(1);
  });

  it('recovers the theme custom properties from the pre element', async () => {
    const html = await codeToHtml('x', {
      lang: 'text',
      themes: { light: 'github-light', dark: 'github-dark-dimmed' },
      defaultColor: false,
    });

    const split = splitHighlightedLines(html);

    expect(split.style['--shiki-light-bg']).toBeTruthy();
    expect(split.style['--shiki-dark-bg']).toBeTruthy();
    expect(split.style['--shiki-light']).toBeTruthy();
  });

  it('keeps nested spans balanced when a line contains several tokens', () => {
    const html =
      '<pre class="shiki" style="--shiki-light:#000"><code>' +
      '<span class="line"><span style="a"><span style="b">x</span></span></span>\n' +
      '<span class="line"><span style="c">y</span></span>' +
      '</code></pre>';

    expect(splitHighlightedLines(html).lines).toEqual([
      '<span style="a"><span style="b">x</span></span>',
      '<span style="c">y</span>',
    ]);
  });

  it('tolerates extra classes on the line span (transformers add them)', () => {
    const html =
      '<pre class="shiki"><code><span class="line highlighted">a</span>\n<span class="line">b</span></code></pre>';

    expect(splitHighlightedLines(html).lines).toEqual(['a', 'b']);
  });

  it('returns a single empty line for input it cannot parse rather than throwing', () => {
    expect(splitHighlightedLines('not html at all').lines).toEqual(['']);
    expect(splitHighlightedLines('').lines).toEqual(['']);
  });
});

describe('parseStyleAttribute', () => {
  it('parses declarations into a React-ready object', () => {
    expect(parseStyleAttribute('--shiki-light:#24292e;--shiki-dark-bg:#22272e')).toEqual({
      '--shiki-light': '#24292e',
      '--shiki-dark-bg': '#22272e',
    });
  });

  it('ignores empty and malformed declarations', () => {
    expect(parseStyleAttribute(';;color:red;;bogus;')).toEqual({ color: 'red' });
    expect(parseStyleAttribute('')).toEqual({});
  });

  it('keeps a value containing a colon intact', () => {
    expect(parseStyleAttribute('background:url(http://x/y)')).toEqual({ background: 'url(http://x/y)' });
  });
});

describe('normalizeRange', () => {
  it('orders a backwards range', () => {
    expect(normalizeRange(9, 4, 20)).toEqual({ start: 4, end: 9 });
  });

  it('clamps a range that hangs off either end', () => {
    expect(normalizeRange(0, 5, 10)).toEqual({ start: 1, end: 5 });
    expect(normalizeRange(8, 99, 10)).toEqual({ start: 8, end: 10 });
  });

  it('rejects a range entirely outside the code', () => {
    expect(normalizeRange(11, 14, 10)).toBeNull();
    expect(normalizeRange(-3, 0, 10)).toBeNull();
  });

  it('rejects nonsense input rather than producing a nonsense range', () => {
    expect(normalizeRange(Number.NaN, 3, 10)).toBeNull();
    expect(normalizeRange(1, Number.POSITIVE_INFINITY, 10)).toBeNull();
    expect(normalizeRange(1.5, 3, 10)).toBeNull();
    expect(normalizeRange(1, 3, 0)).toBeNull();
  });
});

describe('isValidAnchor', () => {
  it('accepts a range wholly inside the snapshot', () => {
    expect(isValidAnchor({ start: 1, end: 1 }, 1)).toBe(true);
    expect(isValidAnchor({ start: 3, end: 7 }, 7)).toBe(true);
  });

  it('rejects out-of-bounds and inverted ranges', () => {
    expect(isValidAnchor({ start: 0, end: 3 }, 10)).toBe(false);
    expect(isValidAnchor({ start: 8, end: 11 }, 10)).toBe(false);
    expect(isValidAnchor({ start: 5, end: 4 }, 10)).toBe(false);
  });
});

describe('partitionAnnotations', () => {
  it('separates anchors that no longer fit the code from those that do', () => {
    const list = [student('a', 1, 2), student('b', 9, 12), student('c', 4, 4)];

    const { anchored, orphaned } = partitionAnnotations(list, 10);

    expect(anchored.map((a) => a.id)).toEqual(['a', 'c']);
    expect(orphaned.map((a) => a.id)).toEqual(['b']);
  });

  it('never silently reanchors an out-of-bounds annotation', () => {
    const { anchored, orphaned } = partitionAnnotations([student('a', 40, 41)], 10);

    expect(anchored).toEqual([]);
    expect(orphaned[0]?.range).toEqual({ start: 40, end: 41 });
  });
});

describe('sortAnnotations', () => {
  it('orders by start line, then by narrowest range, then by creation, then by id', () => {
    const list = [
      student('d', 4, 4, 'note', '2026-08-15T10:00:00Z'),
      student('c', 2, 9),
      student('b', 2, 4),
      student('a', 1, 1),
      student('e', 4, 4, 'note', '2026-08-15T09:00:00Z'),
    ];

    expect(sortAnnotations(list).map((a) => a.id)).toEqual(['a', 'b', 'c', 'e', 'd']);
  });

  it('does not mutate its input', () => {
    const list = [student('b', 5, 5), student('a', 1, 1)];
    sortAnnotations(list);
    expect(list.map((a) => a.id)).toEqual(['b', 'a']);
  });
});

describe('annotationsCoveringLine', () => {
  it('counts every overlapping range that covers the line', () => {
    const list = [student('a', 1, 5), student('b', 3, 3), student('c', 4, 9), student('d', 10, 10)];

    expect(annotationsCoveringLine(list, 3).map((a) => a.id)).toEqual(['a', 'b']);
    expect(annotationsCoveringLine(list, 4).map((a) => a.id)).toEqual(['a', 'c']);
    expect(annotationsCoveringLine(list, 7).map((a) => a.id)).toEqual(['c']);
    expect(annotationsCoveringLine(list, 20)).toEqual([]);
  });
});

describe('groupAnnotationsByEndLine', () => {
  it('files each annotation under the last line of its range', () => {
    const grouped = groupAnnotationsByEndLine([student('a', 1, 3), student('b', 3, 3), student('c', 5, 5)]);

    expect(grouped.get(3)?.map((a) => a.id)).toEqual(['a', 'b']);
    expect(grouped.get(5)?.map((a) => a.id)).toEqual(['c']);
    expect(grouped.get(1)).toBeUndefined();
  });
});

describe('range wording', () => {
  it('reads a single line and a span differently', () => {
    expect(formatRangeLabel({ start: 12, end: 12 })).toBe('Line 12');
    expect(formatRangeLabel({ start: 12, end: 14 })).toBe('Lines 12–14');
    expect(describeRange({ start: 12, end: 12 })).toBe('line 12');
    expect(describeRange({ start: 12, end: 14 })).toBe('lines 12 to 14');
  });

  it('names a line and its annotation count for a screen reader', () => {
    expect(describeLine(3, 0, 40)).toBe('Line 3 of 40, no annotations');
    expect(describeLine(3, 1, 40)).toBe('Line 3 of 40, 1 annotation');
    expect(describeLine(3, 2, 40)).toBe('Line 3 of 40, 2 annotations');
  });
});

describe('fromAuthorAnnotations', () => {
  it('accepts both the single-line and the range content shapes', () => {
    const converted = fromAuthorAnnotations(
      [
        { line: 2, body: 'single' },
        { lines: [4, 6], track: 'cx', body: 'range' },
      ],
      10
    );

    expect(converted).toEqual([
      { id: 'author-0', range: { start: 2, end: 2 }, body: 'single', origin: 'author' },
      { id: 'author-1', range: { start: 4, end: 6 }, body: 'range', origin: 'author', track: 'cx' },
    ]);
  });

  it('drops annotations that do not anchor to the code it was given', () => {
    const converted = fromAuthorAnnotations([{ line: 99, body: 'gone' }, { line: 1, body: 'kept' }], 3);

    expect(converted.map((a) => a.body)).toEqual(['kept']);
  });

  it('drops empty bodies and shapes with no anchor at all', () => {
    const converted = fromAuthorAnnotations(
      [{ line: 1, body: '   ' }, { body: 'anchorless' }, { lines: [2], body: 'half a range' }],
      5
    );

    expect(converted).toEqual([]);
  });

  it('keeps ids stable across calls so React keys do not churn', () => {
    const input = [{ line: 1, body: 'a' }, { line: 2, body: 'b' }];
    expect(fromAuthorAnnotations(input, 5).map((a) => a.id)).toEqual(
      fromAuthorAnnotations(input, 5).map((a) => a.id)
    );
  });
});

describe('add / update / remove', () => {
  it('adds an annotation in sorted position and trims the body', () => {
    const list = [student('a', 5, 5)];

    const next = addAnnotation(list, { id: 'b', range: { start: 2, end: 3 }, body: '  spacing  ' });

    expect(next.map((a) => a.id)).toEqual(['b', 'a']);
    expect(next[0]?.body).toBe('spacing');
    expect(next[0]?.origin).toBe('student');
    expect(list).toHaveLength(1);
  });

  it('refuses an empty body', () => {
    const list = [student('a', 5, 5)];
    expect(addAnnotation(list, { id: 'b', range: { start: 1, end: 1 }, body: '   ' })).toBe(list);
  });

  it('refuses a duplicate id', () => {
    const list = [student('a', 5, 5)];
    expect(addAnnotation(list, { id: 'a', range: { start: 1, end: 1 }, body: 'x' })).toBe(list);
  });

  it('edits a body without moving the anchor', () => {
    const list = [student('a', 5, 7, 'before')];

    const next = updateAnnotation(list, 'a', '  after  ');

    expect(next[0]?.body).toBe('after');
    expect(next[0]?.range).toEqual({ start: 5, end: 7 });
    expect(list[0]?.body).toBe('before');
  });

  it('refuses to blank a body by editing, and ignores an unknown id', () => {
    const list = [student('a', 5, 7, 'before')];
    expect(updateAnnotation(list, 'a', '  ')).toBe(list);
    expect(updateAnnotation(list, 'nope', 'x')).toBe(list);
  });

  it('will not edit or delete an author annotation', () => {
    const list: Annotation[] = [{ id: 'author-0', range: { start: 1, end: 1 }, body: 'theirs', origin: 'author' }];
    expect(updateAnnotation(list, 'author-0', 'mine')).toBe(list);
    expect(removeAnnotation(list, 'author-0')).toBe(list);
  });

  it('removes by id and leaves the rest alone', () => {
    const list = [student('a', 1, 1), student('b', 2, 2)];

    expect(removeAnnotation(list, 'a').map((x) => x.id)).toEqual(['b']);
    expect(removeAnnotation(list, 'zzz')).toBe(list);
  });
});

describe('selection maths', () => {
  it('selects a single valid line and clamps a line outside the code', () => {
    expect(selectLine(3, 10)).toEqual({ start: 3, end: 3 });
    expect(selectLine(0, 10)).toEqual({ start: 1, end: 1 });
    expect(selectLine(99, 10)).toEqual({ start: 10, end: 10 });
    expect(selectLine(1, 0)).toBeNull();
  });

  it('extends and shrinks the end without crossing the start', () => {
    const range = { start: 4, end: 4 };

    expect(adjustRangeEnd(range, 1, 10)).toEqual({ start: 4, end: 5 });
    expect(adjustRangeEnd({ start: 4, end: 6 }, -1, 10)).toEqual({ start: 4, end: 5 });
    expect(adjustRangeEnd(range, -1, 10)).toEqual(range);
    expect(adjustRangeEnd({ start: 4, end: 10 }, 1, 10)).toEqual({ start: 4, end: 10 });
  });

  it('extends and shrinks the start without crossing the end', () => {
    const range = { start: 4, end: 6 };

    expect(adjustRangeStart(range, -1, 10)).toEqual({ start: 3, end: 6 });
    expect(adjustRangeStart(range, 1, 10)).toEqual({ start: 5, end: 6 });
    expect(adjustRangeStart({ start: 6, end: 6 }, 1, 10)).toEqual({ start: 6, end: 6 });
    expect(adjustRangeStart({ start: 1, end: 6 }, -1, 10)).toEqual({ start: 1, end: 6 });
  });

  it('clamps a focused line into the code', () => {
    expect(clampLine(0, 10)).toBe(1);
    expect(clampLine(11, 10)).toBe(10);
    expect(clampLine(5, 10)).toBe(5);
  });
});

describe('toSubmissionAnnotationInputs', () => {
  it('converts student annotations to the PUT body shape, tagged with the given block index', () => {
    const list = [student('a', 3, 3, 'hi'), student('b', 5, 7, 'there')];
    expect(toSubmissionAnnotationInputs(list, 2)).toEqual([
      { blockIndex: 2, startLine: 3, endLine: 3, body: 'hi' },
      { blockIndex: 2, startLine: 5, endLine: 7, body: 'there' },
    ]);
  });

  it('carries track through only when present', () => {
    const withTrack: Annotation = { id: 'a', range: { start: 1, end: 1 }, body: 'x', origin: 'student', track: 'cx' };
    expect(toSubmissionAnnotationInputs([withTrack], 0)).toEqual([
      { blockIndex: 0, startLine: 1, endLine: 1, body: 'x', track: 'cx' },
    ]);
  });

  it('drops author annotations — only student work is ever saved', () => {
    const author: Annotation = { id: 'author-0', range: { start: 1, end: 1 }, body: 'theirs', origin: 'author' };
    expect(toSubmissionAnnotationInputs([author, student('a', 2, 2)], 0)).toEqual([
      { blockIndex: 0, startLine: 2, endLine: 2, body: 'note' },
    ]);
  });
});

describe('fromSubmissionAnnotations', () => {
  const wire: SubmissionAnnotationWire[] = [
    {
      id: 'ann-1',
      blockIndex: 0,
      startLine: 2,
      endLine: 2,
      body: 'first block',
      track: null,
      parentId: null,
      authorId: 'u1',
      createdAt: '2026-01-01T00:00:00Z',
    },
    {
      id: 'ann-2',
      blockIndex: 1,
      startLine: 4,
      endLine: 5,
      body: 'second block',
      track: 'cx',
      parentId: null,
      authorId: 'u1',
      createdAt: '2026-01-02T00:00:00Z',
    },
  ];

  it('keeps only the annotations for the requested block, converted to the internal shape', () => {
    expect(fromSubmissionAnnotations(wire, 1)).toEqual([
      {
        id: 'ann-2',
        range: { start: 4, end: 5 },
        body: 'second block',
        origin: 'student',
        track: 'cx',
        createdAt: '2026-01-02T00:00:00Z',
      },
    ]);
  });

  it('returns an empty array for a block with no annotations', () => {
    expect(fromSubmissionAnnotations(wire, 9)).toEqual([]);
  });

  it('omits track when the wire value is null', () => {
    expect(fromSubmissionAnnotations(wire, 0)).toEqual([
      {
        id: 'ann-1',
        range: { start: 2, end: 2 },
        body: 'first block',
        origin: 'student',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ]);
  });
});
