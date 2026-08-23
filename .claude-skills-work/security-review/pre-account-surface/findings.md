# Security Review — pre-account & upload surface

Anonymous-reachable actions (policy/can.ts:588 PUBLIC_ACTIONS):
  instance:setup:status, instance:bootstrap, profile:public:read,
  profile:avatar:public:read, invite:preview, invite:accept

## 🟠 F1 — Rate-limit keying collapses or is bypassable behind Caddy
api/src/index.ts:67, api/src/auth/rate-limit.ts:52, api/src/routes/auth.ts:90
- API_TRUST_PROXY=false (the .env.example:14 default) + Caddy => every request
  carries Caddy's IP, so all callers share one `ip:` bucket. check() takes the
  MAX across keys, maxAttempts=5, lockout doubles to a 30-min cap.
  => 5 failed logins from one attacker locks out EVERY user, renewably.
- API_TRUST_PROXY=true => Fastify trustProxy:true trusts ALL hops, so the
  leftmost X-Forwarded-For is attacker-controlled => per-IP limit bypassed by
  rotating a forged header. (Per-ACCOUNT keys still hold in both cases.)
- Fix: trustProxy should be Caddy's address/subnet or a hop count, not a bool.

## 🟠 F2 — Unauthenticated Argon2id amplification (no rate limit)
- auth/bootstrap.ts:217 hashes BOTH passwords (2x Argon2id @ 19456 KiB) BEFORE
  the setup-token check at :260 — and before the already-bootstrapped 410 too,
  so it works forever, not just while unclaimed.
- invites/accept.ts:119 hashes BEFORE the invite claim at :128.
- Neither route uses LoginRateLimiter (only auth.ts and profiles.ts do).
- Fix: validate token/claim first, or rate-limit these two routes.

## 🟡 F3 — Invite token in query string, logged in plaintext
- GET /api/v1/invites/lookup?token=... (routes/invites.ts:321)
- index.ts:66 `logger: true` => pino default req serializer logs the full URL.
- VERIFIED with fastify.inject: token appears verbatim in the request log line.
- Contradicts invites/token.ts's stated invariant ("never stored, never
  logged"). Invite tokens are the only gate on registration (design §13).
- Fix: move the token to a header or POST body, or redact `req.url`.

## ✅ Controls verified
- Tokens: randomBytes(32) CSPRNG, SHA-256 at rest, looked up by hash (no
  JS-side comparison to time). Setup token rotates per boot while unclaimed.
- Passwords: Argon2id 19456 KiB/t=2, OWASP-aligned. verifyPassword does
  constant work via a random per-process decoy; `usable &&` is load-bearing,
  so no user-enumeration oracle on login.
- Cookies: httpOnly + secure + SameSite=Lax; refresh cookie path-scoped.
- Signing keys: no defaulted secret; ephemeral keypair + loud warning.
- Bootstrap claim: atomic, `where bootstrapped_at is null and
  setup_token_hash = $1`, race-safe, releases the claim on failure.
- Invite lookup: one message for all four dead-invite states.
- Avatar upload: magic-byte sniff, decoded-format cross-check (kills
  polyglots), pixel cap read from metadata before full decode,
  animated:false, re-encode to WebP, metadata stripped, fixed content-type,
  nosniff on read, bodyLimit at transport AND re-checked in the library.
- SQL: parameterized throughout the reviewed surface.
