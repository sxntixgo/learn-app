// Time handling (design §15): every timestamp is stored UTC; conversion to
// a student's local calendar day happens only at display/aggregation time,
// using this stored IANA zone. Storing an invalid zone would silently break
// every bucket query downstream (heatmap, streaks, feed timestamps), so
// every write path MUST validate through isValidTimeZone before persisting.

/** The fallback zone used whenever `users.timezone` is null (design §15). */
export const DEFAULT_TIMEZONE = 'UTC';

// Intl.DateTimeFormat alone is not strict enough: ECMA-402 also accepts bare
// UTC-offset strings like "+05:00" as a legal `timeZone` option, which is
// not an IANA zone name and does not carry DST rules — exactly the kind of
// value that would silently corrupt heatmap/streak bucketing. Checking
// membership in Intl.supportedValuesOf('timeZone') restricts acceptance to
// real IANA identifiers, the same set Postgres's `AT TIME ZONE` resolves
// against.
const SUPPORTED_TIME_ZONES: ReadonlySet<string> | null =
  typeof Intl.supportedValuesOf === 'function' ? new Set(Intl.supportedValuesOf('timeZone')) : null;

/**
 * True if `tz` is a real IANA time zone name.
 *
 * Goes through `Intl`'s own canonicalization rather than a raw membership
 * check: `resolvedOptions().timeZone` maps a legacy alias (e.g.
 * "Asia/Kolkata") to whatever canonical form the host's tzdata uses (e.g.
 * "Asia/Calcutta"), so an alias not itself present in
 * `supportedValuesOf('timeZone')` is still accepted correctly. "UTC" is
 * special-cased because ECMA-402 always canonicalizes it to itself but some
 * hosts' `supportedValuesOf('timeZone')` omit it (and its `Etc/UTC` alias)
 * from the enumerated list even though it is unambiguously valid. A bare
 * offset like "+05:00" canonicalizes to itself, which is in neither
 * bucket, so it is correctly rejected.
 *
 * Falls back to trusting `Intl.DateTimeFormat`'s acceptance when the host
 * lacks `Intl.supportedValuesOf` (older runtimes) — strictly weaker (it
 * would accept a bare offset), but every environment this runs in (Node 22)
 * has `supportedValuesOf`, so that path is a defensive fallback, not the
 * norm.
 */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.trim().length === 0) return false;

  let canonical: string;
  try {
    canonical = new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return false;
  }

  if (canonical === 'UTC') return true;
  if (!SUPPORTED_TIME_ZONES) return true;
  return SUPPORTED_TIME_ZONES.has(canonical);
}
