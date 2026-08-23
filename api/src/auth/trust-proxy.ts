// ---------------------------------------------------------------------------
// WHICH HOP'S ADDRESS THE RATE LIMITER COUNTS AGAINST.
//
// `request.ip` is what auth.ts keys the login limiter on (`ip:${request.ip}`),
// so whoever controls that value controls the limiter. Behind the design's
// Caddy (§4) there are exactly two ways to get this wrong, and until now the
// setting was a boolean, which means BOTH of them were reachable:
//
//   API_TRUST_PROXY=false — every request arrives from Caddy, so every caller
//     shares one `ip:` bucket. LoginRateLimiter.check() takes the MAX across
//     keys and maxAttempts is 5, with the lockout doubling to a 30-minute cap.
//     Five failed logins from one attacker therefore lock out EVERY user, and
//     five more renew it. An unauthenticated, permanent denial of login.
//
//   API_TRUST_PROXY=true — Fastify's `trustProxy: true` trusts EVERY hop, so
//     it walks X-Forwarded-For to the leftmost entry, which the client wrote.
//     Rotating a forged header gives an attacker a fresh bucket per request
//     and the per-IP limit stops existing.
//
// The correct answer is neither: name the hop that is actually trusted. This
// parses that from the environment and refuses the ambiguous spellings, so a
// deployment cannot end up in either failure mode by accident.
//
// Per-ACCOUNT keys (`account:${email}`) are unaffected either way — they are
// what keeps credential brute-forcing throttled while this setting is wrong.
// ---------------------------------------------------------------------------

/** What Fastify accepts for `trustProxy`. */
export type TrustProxySetting = boolean | number | string[];

export const TRUST_PROXY_ENV = 'API_TRUST_PROXY';

/** Loopback plus the RFC1918 / RFC4193 ranges a container network uses. */
const PRIVATE_RANGES = ['loopback', 'linklocal', 'uniquelocal'];

export interface ParseTrustProxyResult {
  value: TrustProxySetting;
  /** A line worth printing at boot, or null when the setting is unambiguous. */
  warning: string | null;
}

/**
 * Turns `API_TRUST_PROXY` into a Fastify `trustProxy` value.
 *
 * Accepted spellings:
 *
 *   unset / "false" / "off"  — trust nothing. Correct when the API is exposed
 *                              directly, WRONG behind a proxy (see above), so
 *                              it warns when it looks like the wrong choice.
 *   "private"                — trust loopback and the private ranges. The
 *                              right answer for Caddy in a compose network,
 *                              and what docker-compose.yml should set.
 *   a number, e.g. "1"       — trust exactly this many hops closest to the
 *                              server. Use when the proxy count is known.
 *   a CIDR / IP list         — "10.0.0.0/8,192.168.1.5". Most precise.
 *   "true"                   — trust every hop. Accepted because it is what
 *                              the old boolean meant, but it is the forgeable
 *                              case, so it always warns.
 */
export function parseTrustProxy(raw: string | undefined): ParseTrustProxyResult {
  const value = (raw ?? '').trim();

  if (value === '' || /^(false|off|0|no)$/i.test(value)) {
    return { value: false, warning: null };
  }

  if (/^(private|default)$/i.test(value)) {
    return { value: [...PRIVATE_RANGES], warning: null };
  }

  if (/^(true|on|yes)$/i.test(value)) {
    return {
      value: true,
      warning:
        `${TRUST_PROXY_ENV}=true trusts EVERY hop, so a client can forge X-Forwarded-For ` +
        `and give itself a fresh rate-limit bucket per request. Set it to "private" (trust ` +
        `loopback and private ranges), a hop count like "1", or an explicit CIDR list.`,
    };
  }

  // A bare integer is a hop count.
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    if (hops > 0) return { value: hops, warning: null };
    return { value: false, warning: `${TRUST_PROXY_ENV}=0 means trust nothing; use "false" to say so plainly.` };
  }

  // Otherwise: a comma-separated list of addresses, CIDRs, or the named
  // ranges proxy-addr understands. Passed through for Fastify to validate —
  // a typo here throws at boot, which is where a misconfiguration should
  // surface rather than silently degrading to "trust nothing".
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

  if (entries.length === 0) return { value: false, warning: null };
  return { value: entries, warning: null };
}

/** How the effective setting reads in a boot log line. */
export function describeTrustProxy(setting: TrustProxySetting): string {
  if (setting === false) return 'nothing (request.ip is the direct peer)';
  if (setting === true) return 'EVERY hop (X-Forwarded-For is client-controlled)';
  if (typeof setting === 'number') return `the ${setting} hop(s) nearest this server`;
  return setting.join(', ');
}
