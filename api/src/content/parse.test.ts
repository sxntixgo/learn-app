import { describe, it, expect } from 'vitest';
import { parseLesson } from './parse.ts';
import { validateBlocks } from './validate.ts';
import type { Block } from './parse.ts';

describe('parseLesson', () => {
  it('takes the title from YAML frontmatter when present', () => {
    const { title } = parseLesson(`---\ntitle: Frontmatter Title\n---\n\nSome prose.\n`);
    expect(title).toBe('Frontmatter Title');
  });

  it('falls back to the first level-1 heading when there is no frontmatter title', () => {
    const { title } = parseLesson(`# My Lesson\n\nSome body text.\n`);
    expect(title).toBe('My Lesson');
  });

  it('throws a clear error when no title can be found', () => {
    expect(() => parseLesson(`Some content with no heading and no frontmatter.\n`)).toThrow(/title/i);
  });

  it('excludes frontmatter from every prose block', () => {
    const { blocks } = parseLesson(
      `---\ntitle: Hidden Title\ndescription: also hidden\n---\n\nVisible paragraph.\n`,
    );
    for (const block of blocks) {
      if (block.type === 'prose') {
        expect(block.html).not.toContain('Hidden Title');
        expect(block.html).not.toContain('also hidden');
        expect(block.html).not.toContain('---');
      }
    }
  });

  it('parses a fenced code block with a language', () => {
    const { blocks } = parseLesson(`# Title\n\n\`\`\`js\nconst a = 1;\n\`\`\`\n`);
    expect(blocks).toEqual([{ type: 'code', lang: 'js', source: 'const a = 1;' }]);
  });

  it('parses a fenced code block without a language', () => {
    const { blocks } = parseLesson(`---\ntitle: T\n---\n\n\`\`\`\nplain fence\n\`\`\`\n`);
    expect(blocks).toEqual([{ type: 'code', lang: null, source: 'plain fence' }]);
  });

  it('preserves document order across alternating prose and code', () => {
    const { blocks } = parseLesson(
      `---\ntitle: Ordered\n---\n\nFirst paragraph.\n\n\`\`\`js\ncode here\n\`\`\`\n\nSecond paragraph.\n`,
    );

    expect(blocks.map((b) => b.type)).toEqual(['prose', 'code', 'prose']);
    expect(blocks[0]).toMatchObject({ type: 'prose' });
    expect((blocks[0] as { type: 'prose'; html: string }).html).toContain('First paragraph.');
    expect(blocks[1]).toEqual({ type: 'code', lang: 'js', source: 'code here' });
    expect((blocks[2] as { type: 'prose'; html: string }).html).toContain('Second paragraph.');
  });

  it('stores raw, unescaped code source with no HTML markup', () => {
    const { blocks } = parseLesson(
      `---\ntitle: Raw\n---\n\n\`\`\`html\n<div class="x">&amp;</div>\n\`\`\`\n`,
    );

    expect(blocks).toEqual([
      { type: 'code', lang: 'html', source: '<div class="x">&amp;</div>' },
    ]);
    const code = blocks[0] as { type: 'code'; source: string };
    // Raw markdown source, not HTML-escaped by a syntax highlighter or serializer.
    expect(code.source).not.toContain('&lt;');
    expect(code.source).not.toContain('<span');
  });

  describe('in-source annotation markers (design §6.3)', () => {
    it('strips a `#` marker and records it as an annotation with a 1-based line number', () => {
      const markdown = [
        '# Title',
        '',
        '```python',
        'def review(diff):',
        '    for hunk in diff.hunks:        # [!note cx] Shallow module: interface as complex as the body',
        '        pass',
        '```',
        '',
      ].join('\n');

      const { blocks } = parseLesson(markdown);
      expect(blocks).toEqual([
        {
          type: 'code',
          lang: 'python',
          source: 'def review(diff):\n    for hunk in diff.hunks:\n        pass',
          annotations: [{ line: 2, track: 'cx', body: 'Shallow module: interface as complex as the body' }],
        },
      ]);
    });

    it('supports a marker with no track', () => {
      const markdown = ['# Title', '', '```python', 'x = 1  # [!note] just a note', '```', ''].join('\n');

      const { blocks } = parseLesson(markdown);
      const code = blocks[0] as { type: 'code'; annotations?: unknown };
      expect(code.annotations).toEqual([{ line: 1, body: 'just a note' }]);
    });

    it('supports `//` and `--` comment leaders', () => {
      const markdown = [
        '# Title',
        '',
        '```js',
        'const a = 1; // [!note cr] a note',
        '```',
        '',
        '```sql',
        "select 1; -- [!note] sql note",
        '```',
        '',
      ].join('\n');

      const { blocks } = parseLesson(markdown);
      const jsBlock = blocks[0] as { type: 'code'; source: string; annotations?: unknown };
      const sqlBlock = blocks[1] as { type: 'code'; source: string; annotations?: unknown };

      expect(jsBlock.source).toBe('const a = 1;');
      expect(jsBlock.annotations).toEqual([{ line: 1, track: 'cr', body: 'a note' }]);
      expect(sqlBlock.source).toBe('select 1;');
      expect(sqlBlock.annotations).toEqual([{ line: 1, body: 'sql note' }]);
    });

    it('produces output that validates against the blocks schema', () => {
      const markdown = [
        '# Title',
        '',
        '```python',
        'def f():        # [!note cx] a note',
        '    pass',
        '```',
        '',
      ].join('\n');

      const { blocks } = parseLesson(markdown);
      expect(validateBlocks(blocks)).toEqual({ valid: true, errors: [] });
    });

    it('leaves markers inside prose (including inline code spans) completely alone', () => {
      const markdown = [
        '# Title',
        '',
        'See `# [!note cx] not a real marker` inline, and this text: [!note cx] also not a marker.',
        '',
      ].join('\n');

      const { blocks } = parseLesson(markdown);
      const prose = blocks[0] as { type: 'prose'; html: string };
      expect(prose.html).toContain('[!note cx] not a real marker');
      expect(prose.html).toContain('[!note cx] also not a marker');
    });

    it('REGRESSION: a code fence with no markers is byte-identical to un-annotated output', () => {
      const source = 'def review(diff):\n    findings = []  # not a marker, just a comment\n    return findings';
      const markdown = ['# Title', '', '```python', source, '```', ''].join('\n');

      const { blocks } = parseLesson(markdown);
      const expected: Block = { type: 'code', lang: 'python', source };
      expect(blocks).toEqual([expected]);
      expect('annotations' in (blocks[0] as object)).toBe(false);
    });
  });

  describe('lesson frontmatter metadata (design §6.1)', () => {
    it('defaults kind to "lesson" when absent', () => {
      const { kind } = parseLesson('# Title\n\nBody.\n');
      expect(kind).toBe('lesson');
    });

    it('reads track, kind, and estimate from frontmatter', () => {
      const { track, kind, estimateMinutes } = parseLesson(
        '---\ntitle: Exercise 1\ntrack: cr\nkind: exercise\nestimate: 25m\n---\n\nBody.\n',
      );
      expect(track).toBe('cr');
      expect(kind).toBe('exercise');
      expect(estimateMinutes).toBe(25);
    });

    it('omits track and estimateMinutes when absent from frontmatter', () => {
      const { track, estimateMinutes } = parseLesson('# Title\n\nBody.\n');
      expect(track).toBeUndefined();
      expect(estimateMinutes).toBeUndefined();
    });

    it('throws a clear error naming the problem for an invalid kind', () => {
      expect(() =>
        parseLesson('---\ntitle: Bad\nkind: essay\n---\n\nBody.\n'),
      ).toThrow(/kind.*essay/is);
    });

    it('throws a clear error for an unparseable estimate', () => {
      expect(() =>
        parseLesson('---\ntitle: Bad\nestimate: forever\n---\n\nBody.\n'),
      ).toThrow(/estimate/i);
    });
  });

  // Design §8.1: prose is untrusted output. The full policy is proven in
  // sanitize.test.ts; these are the two things parseLesson itself must never
  // stop doing.
  describe('quiz blocks (design §6.3/Task A: tagged fenced blocks with YAML)', () => {
    const validQuizMarkdown = [
      '# Title',
      '',
      '```quiz',
      'pass: 0.7',
      'questions:',
      '  - prompt: Which is a deep module?',
      '    track: cx',
      '    choices:',
      '      - text: A class with one method and a large interface',
      '      - text: A class with a simple interface hiding real complexity',
      '        correct: true',
      '```',
      '',
    ].join('\n');

    it('parses a ```quiz fence into a typed quiz block', () => {
      const { blocks } = parseLesson(validQuizMarkdown);
      expect(blocks).toEqual([
        {
          type: 'quiz',
          pass: 0.7,
          questions: [
            {
              prompt: 'Which is a deep module?',
              track: 'cx',
              choices: [
                { text: 'A class with one method and a large interface' },
                { text: 'A class with a simple interface hiding real complexity', correct: true },
              ],
            },
          ],
        },
      ]);
    });

    it('produces output that validates against the blocks schema', () => {
      const { blocks } = parseLesson(validQuizMarkdown);
      expect(validateBlocks(blocks)).toEqual({ valid: true, errors: [] });
    });

    it('preserves document order alongside prose and code', () => {
      const markdown = ['# Title', '', 'Some prose.', '', validQuizMarkdown.split('\n').slice(2).join('\n')].join(
        '\n',
      );
      const { blocks } = parseLesson(markdown);
      expect(blocks.map((b) => b.type)).toEqual(['prose', 'quiz']);
    });

    it('throws a clear error naming the file line for malformed YAML inside the fence', () => {
      const markdown = [
        '# Title',
        '', // line 2
        '```quiz', // line 3 — fence opens
        'pass: 0.7', // line 4
        'questions:', // line 5
        '  - prompt: Bad indentation ahead', // line 6
        '   choices:', // line 7 — bad indent, malformed YAML
        '```',
        '',
      ].join('\n');

      expect(() => parseLesson(markdown)).toThrow(/line 7/);
    });

    it('throws a clear error when the fence content is not a YAML mapping', () => {
      const markdown = ['# Title', '', '```quiz', '- just', '- a', '- list', '```', ''].join('\n');
      expect(() => parseLesson(markdown)).toThrow(/quiz/i);
    });
  });

  describe('rubric blocks (design §9.4/Task A: tagged fenced blocks with YAML, following quiz exactly)', () => {
    const validRubricMarkdown = [
      '# Title',
      '',
      '```rubric',
      'criteria:',
      '  - name: Spotted the shallow module',
      '    max: 5',
      '    track: cx',
      '  - name: Review tone',
      '    max: 3',
      '```',
      '',
    ].join('\n');

    it('parses a ```rubric fence into a typed rubric block', () => {
      const { blocks } = parseLesson(validRubricMarkdown);
      expect(blocks).toEqual([
        {
          type: 'rubric',
          criteria: [
            { name: 'Spotted the shallow module', max: 5, track: 'cx' },
            { name: 'Review tone', max: 3 },
          ],
        },
      ]);
    });

    it('produces output that validates against the blocks schema', () => {
      const { blocks } = parseLesson(validRubricMarkdown);
      expect(validateBlocks(blocks)).toEqual({ valid: true, errors: [] });
    });

    it('strips nothing: every criterion field a course author wrote is present verbatim', () => {
      // Unlike quiz's `correct`, design §9.4 says there is nothing secret in
      // a rubric — students read the criteria before submitting.
      const { blocks } = parseLesson(validRubricMarkdown);
      const rubric = blocks[0] as { type: 'rubric'; criteria: Array<{ name: string; max: number; track?: string }> };
      expect(rubric.criteria[0]).toEqual({ name: 'Spotted the shallow module', max: 5, track: 'cx' });
      expect(rubric.criteria[1]).toEqual({ name: 'Review tone', max: 3 });
    });

    it('preserves document order alongside prose and code', () => {
      const markdown = ['# Title', '', 'Some prose.', '', validRubricMarkdown.split('\n').slice(2).join('\n')].join(
        '\n',
      );
      const { blocks } = parseLesson(markdown);
      expect(blocks.map((b) => b.type)).toEqual(['prose', 'rubric']);
    });

    it('throws a clear error naming the file line for malformed YAML inside the fence', () => {
      const markdown = [
        '# Title',
        '', // line 2
        '```rubric', // line 3 — fence opens
        'criteria:', // line 4
        '  - name: Bad indentation ahead', // line 5
        '   max: 5', // line 6 — bad indent, malformed YAML
        '```',
        '',
      ].join('\n');

      expect(() => parseLesson(markdown)).toThrow(/line 6/);
    });

    it('throws a clear error when the fence content is not a YAML mapping', () => {
      const markdown = ['# Title', '', '```rubric', '- just', '- a', '- list', '```', ''].join('\n');
      expect(() => parseLesson(markdown)).toThrow(/rubric/i);
    });
  });

  describe('chart blocks (design §6.3/§14.1, Task A: tagged fenced blocks with YAML)', () => {
    const validChartMarkdown = [
      '# Title',
      '',
      '```chart',
      'kind: bar',
      'caption: Lessons completed per module',
      'data:',
      '  - { label: MCP servers, value: 5 }',
      '  - { label: Agents, value: 6 }',
      '```',
      '',
    ].join('\n');

    it('parses a ```chart fence into a typed chart block', () => {
      const { blocks } = parseLesson(validChartMarkdown);
      expect(blocks).toEqual([
        {
          type: 'chart',
          kind: 'bar',
          caption: 'Lessons completed per module',
          data: [
            { label: 'MCP servers', value: 5 },
            { label: 'Agents', value: 6 },
          ],
        },
      ]);
    });

    it('produces output that validates against the blocks schema', () => {
      const { blocks } = parseLesson(validChartMarkdown);
      expect(validateBlocks(blocks)).toEqual({ valid: true, errors: [] });
    });

    it('parses a `kind: line` chart the same way', () => {
      const markdown = validChartMarkdown.replace('kind: bar', 'kind: line');
      const { blocks } = parseLesson(markdown);
      expect((blocks[0] as { kind: string }).kind).toBe('line');
    });

    it('leaves a CSV sidecar path as an unresolved string — resolution is manifest.ts\'s job', () => {
      const markdown = [
        '# Title',
        '',
        '```chart',
        'kind: bar',
        'caption: Enrollment over time',
        'data: ./enrollment.csv',
        '```',
        '',
      ].join('\n');
      const { blocks } = parseLesson(markdown);
      expect(blocks).toEqual([
        { type: 'chart', kind: 'bar', caption: 'Enrollment over time', data: './enrollment.csv' },
      ]);
    });

    it('preserves document order alongside prose and code', () => {
      const markdown = ['# Title', '', 'Some prose.', '', validChartMarkdown.split('\n').slice(2).join('\n')].join(
        '\n',
      );
      const { blocks } = parseLesson(markdown);
      expect(blocks.map((b) => b.type)).toEqual(['prose', 'chart']);
    });

    it('throws a clear error naming the file line for malformed YAML inside the fence', () => {
      const markdown = [
        '# Title',
        '', // line 2
        '```chart', // line 3 — fence opens
        'kind: bar', // line 4
        'caption: Bad indentation ahead', // line 5
        'data:', // line 6
        '  - { label: a, value: 1 }', // line 7
        '   - { label: b, value: 2 }', // line 8 — bad indent, malformed YAML
        '```',
        '',
      ].join('\n');

      expect(() => parseLesson(markdown)).toThrow(/line 8/);
    });

    it('throws a clear error when the fence content is not a YAML mapping', () => {
      const markdown = ['# Title', '', '```chart', '- just', '- a', '- list', '```', ''].join('\n');
      expect(() => parseLesson(markdown)).toThrow(/chart/i);
    });
  });

  describe('figure blocks (design §6.3, Task B: the sanctioned static-SVG escape hatch)', () => {
    const validFigureMarkdown = [
      '# Title',
      '',
      '```figure',
      'caption: A diagram of the pipeline',
      'svg: |',
      '  <svg viewBox="0 0 100 40"><rect width="100" height="40" fill="currentColor" /></svg>',
      '```',
      '',
    ].join('\n');

    it('parses a ```figure fence into a typed figure block', () => {
      const { blocks } = parseLesson(validFigureMarkdown);
      expect(blocks).toEqual([
        {
          type: 'figure',
          caption: 'A diagram of the pipeline',
          svg: '<svg viewBox="0 0 100 40"><rect width="100" height="40" fill="currentColor"></rect></svg>\n',
        },
      ]);
    });

    it('produces output that validates against the blocks schema', () => {
      const { blocks } = parseLesson(validFigureMarkdown);
      expect(validateBlocks(blocks)).toEqual({ valid: true, errors: [] });
    });

    it('strips a <script> element from the figure SVG (sanitize.ts\'s first caller, design §8.1)', () => {
      const markdown = [
        '# Title',
        '',
        '```figure',
        'caption: Hostile figure',
        'svg: |',
        '  <svg viewBox="0 0 10 10"><script>alert(1)</script><circle cx="5" cy="5" r="4" /></svg>',
        '```',
        '',
      ].join('\n');

      const { blocks } = parseLesson(markdown);
      const figure = blocks[0] as { type: 'figure'; svg: string };
      expect(figure.svg).not.toContain('<script');
      expect(figure.svg).not.toContain('alert(1)');
      expect(figure.svg).toContain('<circle');
    });

    it('strips an onload event handler from the figure SVG, keeping the rest of the element', () => {
      const markdown = [
        '# Title',
        '',
        '```figure',
        'caption: Hostile figure',
        'svg: |',
        '  <svg onload="steal()" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" onclick="steal()" /></svg>',
        '```',
        '',
      ].join('\n');

      const { blocks } = parseLesson(markdown);
      const figure = blocks[0] as { type: 'figure'; svg: string };
      expect(figure.svg).not.toContain('onload');
      expect(figure.svg).not.toContain('onclick');
      expect(figure.svg).not.toContain('steal()');
      expect(figure.svg).toContain('<circle');
    });

    it('the block imported cleanly still validates once the hostile SVG is stripped', () => {
      const markdown = [
        '# Title',
        '',
        '```figure',
        'caption: Hostile figure',
        'svg: |',
        '  <svg viewBox="0 0 10 10"><script>alert(1)</script><circle cx="5" cy="5" r="4" /></svg>',
        '```',
        '',
      ].join('\n');
      const { blocks } = parseLesson(markdown);
      expect(validateBlocks(blocks)).toEqual({ valid: true, errors: [] });
    });

    it('preserves document order alongside prose and code', () => {
      const markdown = ['# Title', '', 'Some prose.', '', validFigureMarkdown.split('\n').slice(2).join('\n')].join(
        '\n',
      );
      const { blocks } = parseLesson(markdown);
      expect(blocks.map((b) => b.type)).toEqual(['prose', 'figure']);
    });

    it('throws a clear error naming the file line for malformed YAML inside the fence', () => {
      const markdown = [
        '# Title',
        '', // line 2
        '```figure', // line 3 — fence opens
        'caption: Bad indentation ahead', // line 4
        'svg: "<svg></svg>"', // line 5
        'bogus:', // line 6
        '   nested: true', // line 7
        '  also: true', // line 8 — bad indent, malformed YAML
        '```',
        '',
      ].join('\n');

      expect(() => parseLesson(markdown)).toThrow(/line 8/);
    });

    it('throws a clear error when the fence content is not a YAML mapping', () => {
      const markdown = ['# Title', '', '```figure', '- just', '- a', '- list', '```', ''].join('\n');
      expect(() => parseLesson(markdown)).toThrow(/figure/i);
    });
  });

  describe('prose sanitization', () => {
    function prose(markdown: string): string {
      return parseLesson(markdown)
        .blocks.filter((b) => b.type === 'prose')
        .map((b) => b.html)
        .join('\n');
    }

    it('never emits a javascript: URL from a plain markdown link — no raw HTML required', () => {
      const html = prose('# T\n\n[click](javascript:alert(1)) and [ok](https://example.com/a)\n');
      expect(html.toLowerCase()).not.toContain('javascript:');
      expect(html).toContain('click');
      expect(html).toContain('https://example.com/a');
    });

    it('never emits raw HTML from a markdown file, script or otherwise', () => {
      const html = prose('# T\n\nBefore.\n\n<script>alert(1)</script>\n\n<div onclick="alert(2)">x</div>\n\nAfter.\n');
      expect(html).not.toContain('<script');
      expect(html).not.toContain('alert(1)');
      expect(html).not.toMatch(/onclick/i);
      expect(html).toContain('Before.');
      expect(html).toContain('After.');
    });
  });
});
