import { describe, it, expect } from 'vitest';
import { parseTrustProxy, describeTrustProxy, TRUST_PROXY_ENV } from './trust-proxy.ts';

/**
 * The setting that decides what `request.ip` is, and therefore what the login
 * rate limiter counts against. Both of the old boolean's values were wrong
 * behind a proxy — see the module header — so these pin the spellings that
 * are now available and, more importantly, which ones warn.
 */
describe('parseTrustProxy', () => {
  it('trusts nothing when unset', () => {
    expect(parseTrustProxy(undefined)).toEqual({ value: false, warning: null });
  });

  it('trusts nothing for the empty string and whitespace', () => {
    expect(parseTrustProxy('').value).toBe(false);
    expect(parseTrustProxy('   ').value).toBe(false);
  });

  it.each(['false', 'FALSE', 'off', 'no', '0'])('treats %s as trust-nothing, without warning', (raw) => {
    expect(parseTrustProxy(raw)).toEqual({ value: false, warning: null });
  });

  it('maps "private" to the loopback and private ranges', () => {
    const { value, warning } = parseTrustProxy('private');
    expect(value).toEqual(['loopback', 'linklocal', 'uniquelocal']);
    expect(warning).toBeNull();
  });

  it('accepts a hop count', () => {
    expect(parseTrustProxy('1')).toEqual({ value: 1, warning: null });
    expect(parseTrustProxy('2').value).toBe(2);
  });

  it('accepts a CIDR list and trims it', () => {
    expect(parseTrustProxy('10.0.0.0/8, 192.168.1.5').value).toEqual(['10.0.0.0/8', '192.168.1.5']);
  });

  it('WARNS on true, because that is the forgeable setting', () => {
    // `trustProxy: true` walks X-Forwarded-For to the leftmost entry, which
    // the client wrote. It still works — it is what the old boolean meant —
    // but it must never be chosen silently.
    const { value, warning } = parseTrustProxy('true');
    expect(value).toBe(true);
    expect(warning).toContain('forge');
    expect(warning).toContain(TRUST_PROXY_ENV);
  });

  it.each(['on', 'yes', 'TRUE'])('warns for %s too', (raw) => {
    expect(parseTrustProxy(raw).warning).not.toBeNull();
  });

  it('treats an explicit 0 as trust-nothing, and says so', () => {
    const { value, warning } = parseTrustProxy('0');
    expect(value).toBe(false);
    // "0" is caught by the false-ish branch before the numeric one; either
    // way it must not become `trustProxy: 0`, which Fastify reads as falsy
    // but which reads to a human like a configured hop count.
    expect(warning).toBeNull();
  });

  it('never silently returns true for an unrecognised value', () => {
    // The dangerous failure is a typo that lands on "trust everything".
    for (const raw of ['ture', 'yes please', 'caddy', '-1', 'null']) {
      expect(parseTrustProxy(raw).value).not.toBe(true);
    }
  });
});

describe('describeTrustProxy', () => {
  it('describes each shape for the boot log', () => {
    expect(describeTrustProxy(false)).toContain('nothing');
    expect(describeTrustProxy(true)).toContain('EVERY hop');
    expect(describeTrustProxy(2)).toContain('2 hop');
    expect(describeTrustProxy(['10.0.0.0/8'])).toBe('10.0.0.0/8');
  });
});
