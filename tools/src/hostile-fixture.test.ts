import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseLesson } from '@learn/api/content/parse';
import { describe, it, expect } from 'vitest';
import { validateCourseDir } from './validate.ts';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const validateCli = path.join(here, 'validate.ts');
const fixture = path.resolve(here, '../test-fixtures/hostile-course');

// ---------------------------------------------------------------------------
// The malicious fixture repo, run end to end through the real validate CLI —
// the same code path the importer uses to decide whether to write anything.
//
// Every assertion below names the SPECIFIC rejection. "The import failed" is
// not a security test: a manifest typo fails too, and a check that cannot
// tell the two apart cannot notice when the defence stops working.
// ---------------------------------------------------------------------------

describe('hostile fixture repo — path rejections', () => {
  it('reports every refused path in one pass, each naming its manifest entry and its reason', async () => {
    const result = await validateCourseDir(fixture);

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      '../../etc/passwd: contains a ".." segment — a lesson path may not climb out of the course directory. ' +
        '(referenced by module "traversal-relative")',
      '/etc/passwd: is an absolute path — manifest paths must be relative to the course directory. ' +
        '(referenced by module "traversal-absolute")',
      'modules/01-payloads/../../../../etc/passwd: contains a ".." segment — a lesson path may not climb out of ' +
        'the course directory. (referenced by module "traversal-deep")',
      'escape-link.md: "escape-link.md" is a symbolic link — symlinks are refused inside a content repo, ' +
        'whether they point inside it or out of it. (referenced by module "symlinked-file")',
      'linkdir/inside.md: "linkdir" is a symbolic link — symlinks are refused inside a content repo, ' +
        'whether they point inside it or out of it. (referenced by module "symlinked-dir")',
    ]);
  });

  it('never reveals where on the filesystem anything resolved to', async () => {
    const result = await validateCourseDir(fixture);
    for (const problem of result.problems) {
      expect(problem, problem).not.toContain(fixture);
      expect(problem, problem).not.toMatch(/\/(?:home|root|var|workspaces)\//);
    }
  });

  it('exits 1 from the CLI, importing nothing', async () => {
    const failure = await run(process.execPath, [validateCli, fixture]).then(
      () => undefined,
      (err: { code?: number; stderr?: string }) => err,
    );

    expect(failure?.code).toBe(1);
    expect(failure?.stderr).toContain('is an absolute path');
    expect(failure?.stderr).toContain('is a symbolic link');
  });
});

describe('hostile fixture repo — payload lessons', () => {
  async function parseFixtureLesson(rel: string): Promise<string> {
    const markdown = await readFile(path.join(fixture, rel), 'utf8');
    return parseLesson(markdown)
      .blocks.filter((b) => b.type === 'prose')
      .map((b) => b.html)
      .join('\n');
  }

  it('strips <script>, an inline handler, an iframe and a <style> beacon', async () => {
    const html = await parseFixtureLesson('modules/01-payloads/script-tag.md');

    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert(1)');
    expect(html).not.toMatch(/onmouseover/i);
    expect(html).not.toContain('alert(2)');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('evil.example');
    expect(html).toContain('Ordinary prose that must survive.');
  });

  it('strips javascript: from a raw <a href> AND from a plain markdown link', async () => {
    const html = await parseFixtureLesson('modules/01-payloads/js-href.md');

    expect(html.toLowerCase()).not.toContain('javascript:');
    expect(html).not.toContain('alert(');
    // The markdown link needed no raw HTML at all — this is the payload that
    // would have shipped even with raw HTML disabled.
    expect(html).toContain('markdown');
    expect(html).toContain('https://example.com/docs');
  });

  it('strips <img onerror> and a javascript: image URL, keeping the legitimate image', async () => {
    const html = await parseFixtureLesson('modules/01-payloads/img-onerror.md');

    expect(html).not.toMatch(/onerror/i);
    expect(html).not.toContain('alert(');
    expect(html.toLowerCase()).not.toContain('javascript:');
    expect(html).toContain('https://example.com/diagram.png');
  });
});
