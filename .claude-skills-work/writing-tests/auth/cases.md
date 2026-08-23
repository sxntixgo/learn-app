# Test cases — api/src/auth/**

Goal: raise statement coverage 91.9% -> >=97% with tests that would FAIL if the
behaviour they describe regressed. Each case names the real failure it guards.

## Unit: bootstrap.ts — parseBootstrapRequest / parseAccount (pure)
Contract: validate + normalize a wizard submission BEFORE any claim is made.
Returns `{ok:true,value}` or `{ok:false,message}`. Never throws.

| # | Category | Case | Guards against |
|---|---|---|---|
| B1 | error | body is not an object (null / array / string / number) | Fastify can hand a route a JSON array or scalar; a crash or a TypeError here is a 500 on the one unauthenticated route |
| B2 | error | `admin.email` absent entirely (vs. present-but-bad, already covered) | the "required" message path |
| B3 | boundary | email of exactly MAX_EMAIL_LENGTH accepted; one over refused | an unbounded email reaches a column with no length guard |
| B4 | edge | `displayName` present but not a string (number, object) | a non-string display name would be written to the column via pg's coercion |
| B5 | boundary | displayName exactly MAX_DISPLAY_NAME_LENGTH accepted; one over refused | same |
| B6 | edge | displayName `'   '` / `''` normalizes to null, not `''` | an empty-string display name renders as a blank name everywhere |
| B7 | happy | timezone `null`/absent -> null; valid IANA passes through | |
| B8 | edge | setupToken that is only whitespace is refused | `' '` is truthy; a whitespace token must not reach the claim |

## Unit: account-fields.ts — parseHandle / parsePassword (pure)
| # | Category | Case | Guards against |
|---|---|---|---|
| A1 | error | handle absent / not a string | bootstrap and invites/accept must refuse the same shapes |
| A2 | boundary | handle of 2 chars ok, 1 char refused, 31 ok, 32 refused | the pattern's `{1,30}` quantifier is easy to get off by one, and the DB enforces the same rule — a looser parse means a 500 instead of a 400 |
| A3 | edge | handle is upper-cased / padded -> normalized to lower and trimmed | |
| A4 | error | every RESERVED_HANDLE is refused, case-insensitively | a student claiming `/u/admin` |
| A5 | boundary | password of exactly MIN length ok, one under refused | |
| A6 | boundary | password of exactly MAX length ok, one over refused (CPU exhaustion bound) | an unbounded Argon2id input |
| A7 | edge | password is NOT trimmed or normalized | trimming a password silently changes the credential |

## Unit: bootstrap.ts — bootstrapInstance (DB)
| # | Category | Case | Guards against |
|---|---|---|---|
| C1 | happy | no `deps.hashPassword` -> both accounts land with `password_hash = NULL` | a placeholder hash being invented; NULL is "no credential" |
| C2 | error | the token is checked BEFORE any password is hashed | the documented CPU/memory exhaustion primitive: an anonymous caller buying two Argon2id runs per request on a claimed or unauthenticated instance |
| C3 | error | already-bootstrapped instance -> `gone`, and still no hashing | as above, the `gone` path used to hash first |
| C4 | error | email/handle already taken -> `invalid`, and the CLAIM IS RELEASED | a fumbled wizard submission permanently bricking a fresh instance |
| C5 | error | an unexpected DB error (constraint violation that is not 23505) is RETHROWN, claim released | swallowing a real fault as a 400, and burning the claim |
| C6 | edge | the setup token is rotated between the pre-check and the claim -> `unauthorized`, instance still unclaimed | the pre-check being mistaken for the authorization; a revoked token must still lose |
| C7 | error | `instance_state` has no row -> throws a message naming migrations | a fresh DB silently answering "unauthorized" instead of "you did not migrate" |

## Unit: refresh-token.ts
| # | Category | Case | Guards against |
|---|---|---|---|
| R1 | boundary | `rotateRefreshToken(pool, '')` -> `unknown` without opening a transaction | an empty cookie hashing to a real digest and burning a pool connection per request |
| R2 | boundary | `revokeSession(pool, '')` -> false | as above on logout |
| R3 | edge | the row is spent between the `select ... for update` and the `update` -> `reuse`, family revoked | the belt-and-braces `and used_at is null`; without it a lost race silently mints a second live token in the family |
| R4 | error | a DB failure mid-rotation propagates AND releases the pooled client, leaving the token unspent | a leaked pool client — the API deadlocks after `max` such failures — and a half-rotated family |

## Unit: setup-token.ts
| # | Category | Case | Guards against |
|---|---|---|---|
| S1 | happy | with no `log` option the banner goes to console.log (the container logs) | the default sink being wrong: the operator would never see the only copy of the token |
| S2 | edge | the instance is claimed between the read and the update -> no token issued, `setup_token_hash` stays null | re-arming a setup token on an instance somebody already owns |
| S3 | error | `instance_state` has no row -> throws naming migrations | |

## Unit: password.ts
| # | Category | Case | Guards against |
|---|---|---|---|
| P1 | error | `hashPassword(non-string)` throws TypeError | a JSON body sending `password: 123`, which argon2 would otherwise coerce or crash on |
| P2 | edge | a stored value that LOOKS like an Argon2id digest but is corrupt -> false, not a throw | a truncated/corrupted column turning every login into a 500 |

## Unit: trust-proxy.ts
| # | Category | Case | Guards against |
|---|---|---|---|
| T1 | boundary | `"00"` (a numeric zero that the false-ish regex does not catch) -> trust nothing, WITH a warning | `trustProxy: 0`, which Fastify reads as falsy but which reads to a human as a configured hop count |
| T2 | edge | a list that is only separators (`","`, `" , "`) -> trust nothing | handing Fastify an empty array, which it rejects at boot |

## Unit: keys.ts
| # | Category | Case | Guards against |
|---|---|---|---|
| K1 | error | `AUTH_JWT_PUBLIC_KEY` is a valid PEM but not Ed25519 -> throws naming the env var | a half-finished rotation publishing a key a Go verifier cannot use |
| K2 | happy | `getSigningKeys()` returns the SAME object on every call; `resetSigningKeys()` clears it | re-resolving per call would mint a fresh ephemeral keypair per request and invalidate every token instantly |
