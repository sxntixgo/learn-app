# Security Review: credential change + session refresh

Surface mapped:
- POST /api/v1/auth/password — body, session cookie, request.ip
- me:password:update in the closed matrix
- web/proxy.ts refresh — reads cookies, calls the API, sets cookies

## 🟡 Medium
1. Stateless access tokens survive a password change (api/src/auth/actor.ts:44)
   - Exploit: attacker holds a stolen learn_at. Victim changes their password.
     revokeAllForUser kills every REFRESH family, but actorFor only verifies the
     JWT signature — no database read — so the stolen access token keeps working
     until its own exp, up to 15 minutes.
   - Impact: the change does not immediately evict the attacker, which is the
     entire reason a person changes a password under suspicion.
   - Fix (not applied): a token version on users, claimed in the JWT and compared
     per request. Costs a database read on the hot path, which design §13
     deliberately avoids. Reported rather than changed — it is a design trade,
     not an oversight, and it should be a deliberate decision.
   - Partial mitigation already present: the attacker cannot refresh, so the
     window is bounded by exp and does not renew.

2. A cross-site navigation can force a refresh; racing two destroys the session
   (web/proxy.ts)
   - Exploit: SameSite=Lax sends session cookies on top-level cross-site GETs.
     A hostile page opens two windows at learn.lan at once; both are document
     navigations, both refresh, the second presents a spent token, the API's
     reuse detection treats it as theft and revokes the whole family.
   - Impact: unauthenticated session denial-of-service — a third party can log
     the victim out at will.
   - Fix (APPLIED): only refresh when Sec-Fetch-Site is same-origin or none. A
     cross-site navigation now renders signed-out rather than rotating.

## 🟢 Low
3. An empty x-forwarded-for is forwarded rather than omitted (web/proxy.ts)
   - Exploit: marginal. With API_TRUST_PROXY on, the API parses an empty header
     where it would otherwise use the socket address; a degenerate value could
     collapse per-IP rate-limit keys together.
   - Fix (APPLIED): send the header only when there is a value.

4. Password attempts and login attempts count on separate keys
   - Both are limited with the same policy, so neither is unbounded. Noted
     because someone holding a session can guess the current password without
     tripping the login lockout — by design, but worth being deliberate about.

## ✅ Controls verified
- Current password required despite a valid session (a borrowed laptop cannot
  lock the owner out) — mutation-tested.
- All other sessions revoked on success — mutation-tested.
- Shape validated before the Argon2id verify, so the route is not a password
  oracle with a free CPU burn attached — mutation-tested.
- Rate limited per IP and per account, with Retry-After, and reset on success.
- No IDOR: no user id is accepted from the client; can() is asked with actor.id.
- CSRF: SameSite=Lax blocks cross-site POST, and a JSON content-type forces a
  preflight the API answers with no CORS headers.
- No secret in logs: Fastify logs method/url/status, never bodies; no error
  message echoes either password.
- NULL password_hash (the invite seam) answers 401 rather than crashing.
- Upper length bound present, so Argon2id cannot be driven with unbounded input.
