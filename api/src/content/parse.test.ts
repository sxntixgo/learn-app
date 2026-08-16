import { describe, it, expect } from 'vitest';
import { parseLesson } from './parse.ts';

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
});
