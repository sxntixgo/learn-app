import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { sanitizeProseHtml, sanitizeSvg } from './sanitize.ts';

const fixtureRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../tools/test-fixtures/hostile-course',
);

describe('sanitizeProseHtml', () => {
  it('removes a <script> element AND its contents, rather than unwrapping it to text', () => {
    const out = sanitizeProseHtml('<p>before</p><script>alert(1)</script><p>after</p>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
    expect(out).toContain('before');
    expect(out).toContain('after');
  });

  it('strips an inline event handler but keeps the element it was attached to', () => {
    const out = sanitizeProseHtml('<img src="https://example.com/a.png" alt="a" onerror="alert(1)">');
    expect(out).not.toMatch(/onerror/i);
    expect(out).not.toContain('alert(1)');
    expect(out).toContain('<img');
    expect(out).toContain('alt="a"');
  });

  it('strips a javascript: href, keeping the link text', () => {
    const out = sanitizeProseHtml('<a href="javascript:alert(1)">click</a>');
    expect(out).not.toContain('javascript:');
    expect(out).toContain('click');
  });

  it('strips javascript: however it is cased, spaced or entity-encoded', () => {
    for (const href of [
      'JaVaScRiPt:alert(1)',
      ' javascript:alert(1)',
      'java\tscript:alert(1)',
      '&#106;avascript:alert(1)',
      'javascript&colon;alert(1)',
    ]) {
      const out = sanitizeProseHtml(`<a href="${href}">x</a>`);
      expect(out.toLowerCase()).not.toMatch(/href="\s*(&#\d+;|&\w+;|[^"])*j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t/);
    }
  });

  it('removes an iframe entirely', () => {
    const out = sanitizeProseHtml('<iframe src="https://evil.example/x"></iframe><p>ok</p>');
    expect(out).not.toContain('iframe');
    expect(out).toContain('ok');
  });

  it('removes <object>, <embed>, <form> and <style>', () => {
    const out = sanitizeProseHtml(
      '<object data="x"></object><embed src="x"><form action="https://evil.example"><input name="p"></form>' +
        '<style>body{background:url(https://evil.example)}</style><p>kept</p>',
    );
    for (const tag of ['object', 'embed', 'form', 'style']) {
      expect(out).not.toContain(`<${tag}`);
    }
    expect(out).not.toContain('evil.example');
    expect(out).toContain('kept');
  });

  it('removes inline SVG from prose (figures are their own block type, not raw prose HTML)', () => {
    const out = sanitizeProseHtml('<p>a</p><svg onload="alert(1)"><script>alert(2)</script></svg>');
    expect(out).not.toContain('svg');
    expect(out).not.toMatch(/onload/i);
    expect(out).not.toContain('alert');
    expect(out).toContain('a');
  });

  it('drops HTML comments (a conditional comment is a script vector on old renderers)', () => {
    expect(sanitizeProseHtml('<p>a</p><!--[if IE]><script>alert(1)</script><![endif]-->')).not.toContain('<!--');
  });

  it('keeps what technical documentation legitimately needs', () => {
    const legit =
      '<h2 id="x">Heading</h2><p><strong>bold</strong> <em>em</em> <code>inline()</code> ' +
      '<a href="https://example.com/doc">link</a> <a href="/relative">rel</a> <a href="#anchor">anchor</a></p>' +
      '<ul><li>one</li></ul><ol><li>two</li></ol><blockquote><p>quote</p></blockquote>' +
      '<pre><code class="language-ts">const a = 1;</code></pre>' +
      '<table><thead><tr><th>h</th></tr></thead><tbody><tr><td>c</td></tr></tbody></table>' +
      '<img src="https://example.com/a.png" alt="alt"><details><summary>s</summary><p>body</p></details>' +
      '<kbd>Ctrl</kbd><sup>1</sup><sub>2</sub><hr><br>';
    const out = sanitizeProseHtml(legit);

    for (const needle of [
      '<h2',
      '<strong>',
      '<em>',
      '<code>',
      'https://example.com/doc',
      'href="/relative"',
      'href="#anchor"',
      '<ul>',
      '<ol>',
      '<blockquote>',
      'language-ts',
      '<table>',
      '<th>',
      '<td>',
      '<img',
      '<details>',
      '<summary>',
      '<kbd>',
      '<sup>',
      '<sub>',
      '<hr>',
      '<br>',
    ]) {
      expect(out, `expected sanitizer to keep ${needle}`).toContain(needle);
    }
  });
});

describe('sanitizeSvg', () => {
  // Not wired into any block type yet: `figure` arrives in Phase 10. This is
  // the hardening for it, built and proven now (design §8.1).
  const evil = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)">
  <title>Diagram</title>
  <script>alert(2)</script>
  <rect x="1" y="1" width="2" height="2" fill="#336699" onclick="alert(3)" onmouseover="alert(4)"/>
  <a href="javascript:alert(5)"><text x="1" y="9">label</text></a>
  <image href="https://evil.example/tracker.png"/>
  <use href="https://evil.example/x.svg#a"/>
  <use href="#local" xlink:href="https://evil.example/x.svg#a"/>
  <style>rect { fill: url(https://evil.example/p.svg#p) }</style>
  <foreignObject width="5" height="5"><div xmlns="http://www.w3.org/1999/xhtml"><script>alert(6)</script>text-in-fo</div></foreignObject>
  <path d="M0 0L1 1" stroke="red" stroke-width="2"/>
</svg>`;

  const clean = sanitizeSvg(evil);

  it('removes <script> and its contents', () => {
    expect(clean).not.toContain('<script');
    expect(clean).not.toContain('alert(2)');
  });

  it('removes every on* event handler', () => {
    expect(clean).not.toMatch(/\son[a-z]+\s*=/i);
    for (const payload of ['alert(1)', 'alert(3)', 'alert(4)']) {
      expect(clean).not.toContain(payload);
    }
  });

  it('removes <foreignObject> together with the HTML it smuggles', () => {
    expect(clean).not.toMatch(/foreignobject/i);
    expect(clean).not.toContain('text-in-fo');
    expect(clean).not.toContain('alert(6)');
  });

  it('removes external references: <image>, external <use>, xlink:href and <style>', () => {
    expect(clean).not.toContain('evil.example');
    expect(clean).not.toContain('<image');
    expect(clean).not.toMatch(/xlink:href/i);
    expect(clean).not.toContain('<style');
  });

  it('removes <a> so an SVG cannot be a navigation surface', () => {
    expect(clean).not.toContain('javascript:');
    expect(clean).not.toContain('<a ');
  });

  it('keeps the drawing itself — geometry, presentation attributes and title', () => {
    expect(clean).toContain('<svg');
    expect(clean).toContain('viewBox="0 0 10 10"');
    expect(clean).toContain('<title>Diagram</title>');
    expect(clean).toContain('<rect');
    expect(clean).toContain('fill="#336699"');
    expect(clean).toContain('<path');
    expect(clean).toContain('d="M0 0L1 1"');
    expect(clean).toContain('stroke-width="2"');
    expect(clean).toContain('label');
  });

  it('keeps a fragment-only <use> reference but drops the whole element when it points off-document', () => {
    expect(sanitizeSvg('<svg><use href="#local"/></svg>')).toContain('href="#local"');
    expect(sanitizeSvg('<svg><use href="https://evil.example/x.svg#a"/></svg>')).not.toContain('evil.example');
  });

  it('drops url() paint that points at an external document, keeping url(#local)', () => {
    expect(sanitizeSvg('<svg><rect fill="url(#grad)"/></svg>')).toContain('fill="url(#grad)"');
    expect(sanitizeSvg('<svg><rect fill="url(https://evil.example/p.svg#p)"/></svg>')).not.toContain('evil.example');
  });

  it('drops style attributes and unknown attributes wholesale (allowlist, not denylist)', () => {
    const out = sanitizeSvg('<svg><rect style="behavior:url(#x)" data-x="1" formaction="x" ping="y"/></svg>');
    expect(out).not.toContain('style=');
    expect(out).not.toContain('data-x');
    expect(out).not.toContain('formaction');
    expect(out).not.toContain('ping');
  });

  it('drops comments, doctypes and processing instructions', () => {
    const out = sanitizeSvg('<?xml version="1.0"?><!DOCTYPE svg><svg><!-- c --><rect/></svg>');
    expect(out).not.toContain('<!');
    expect(out).not.toContain('<?');
  });

  it('sanitizes the committed hostile SVG fixture', async () => {
    const raw = await readFile(path.join(fixtureRoot, 'assets/evil.svg'), 'utf8');
    const out = sanitizeSvg(raw);
    expect(raw).toContain('<script');
    expect(raw).toMatch(/onload=/i);
    expect(out).not.toContain('<script');
    expect(out).not.toMatch(/\son[a-z]+\s*=/i);
    expect(out).not.toMatch(/foreignobject/i);
    expect(out).not.toContain('evil.example');
    expect(out).toContain('<svg');
  });
});
