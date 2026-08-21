import { describe, it, expect } from 'vitest';
import { buildCsp } from '../../proxy.ts';

/**
 * The policy is asserted directly rather than through a served response,
 * because what matters is which directives it contains — and getting that
 * wrong is silent in both directions: too loose is security theatre, too
 * tight strips the palette out of every code block.
 */
describe('content security policy', () => {
  const csp = buildCsp('TESTNONCE');
  const directive = (name: string): string =>
    csp
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith(`${name} `) || d === name) ?? '';

  it('denies everything by default', () => {
    expect(directive('default-src')).toBe("default-src 'none'");
  });

  it('carries the per-request nonce and does NOT allow inline scripts', () => {
    const scriptSrc = directive('script-src');

    expect(scriptSrc).toContain("'nonce-TESTNONCE'");
    // The empirical finding this policy rests on: Next stamps the nonce onto
    // all of its own scripts, so 'unsafe-inline' is unnecessary. If a future
    // Next upgrade breaks that, this assertion should fail rather than
    // someone quietly re-adding it.
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it('restricts images to same-origin and data: URIs', () => {
    // The control identified by the Phase 5 hardening review: without it a
    // content repo can make an authenticated reader's browser fetch an
    // arbitrary third-party URL simply by including an <img> in a lesson.
    const imgSrc = directive('img-src');

    expect(imgSrc).toBe("img-src 'self' data:");
    expect(imgSrc).not.toContain('https:');
    expect(imgSrc).not.toContain('*');
  });

  it('allows the web app manifest to be fetched (design decision #6, plan Phase 14)', () => {
    expect(directive('manifest-src')).toBe("manifest-src 'self'");
  });

  it('allows no external origins anywhere in the policy', () => {
    expect(csp).not.toMatch(/https?:\/\//);
  });

  it('forbids framing and restricts form submission and base URI', () => {
    expect(directive('frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive('form-action')).toBe("form-action 'self'");
    expect(directive('base-uri')).toBe("base-uri 'none'");
    expect(directive('object-src')).toBe("object-src 'none'");
  });

  it('permits inline styles, deliberately, and only styles', () => {
    // Next injects critical CSS inline, and Shiki emits inline style
    // ATTRIBUTES on every highlighted span. Documented weakening: the
    // exposure is style injection, not script execution.
    expect(directive('style-src')).toContain("'unsafe-inline'");
    expect(directive('font-src')).toBe("font-src 'self'");
    expect(directive('connect-src')).toBe("connect-src 'self'");
  });
});
