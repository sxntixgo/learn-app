# POST /api/v1/auth/password — case list

## Contract
- In: session cookie (actor), body { currentPassword, newPassword }
- Out: 204 | 400 | 401 | 403 | 429
- Side effects: users.password_hash updated; ALL refresh families revoked;
  a fresh session issued for the caller's device (both cookies re-set)

## Happy path
1. correct current + valid new -> 204
2. the OLD password stops working and the NEW one works (via /auth/login)
3. both session cookies are re-issued, with a live max-age
4. every other session is revoked; exactly one live refresh family remains

## Boundaries (MIN 12, MAX 200)
5. new password of exactly 12 -> accepted
6. new password of 11 -> 400
7. new password of exactly 200 -> accepted
8. new password of 201 -> 400

## Edges
9.  new === current -> 400 (rotating to the same secret is not a rotation)
10. missing body / missing fields -> 400
11. non-string types -> 400
12. account whose password_hash is NULL (the bootstrap seam) -> 401, not a crash

## Error paths
13. wrong current password -> 401, and the stored hash is UNCHANGED
14. wrong current password -> other sessions survive (no partial application)
15. anonymous caller -> 403, nothing changed
16. repeated wrong attempts -> 429 from the shared login limiter
17. a successful change RESETS the limiter (one typo must not lock you out)

## Ordering (a property, not a value — needs its own case)
18. too-short new password + WRONG current password -> 400, not 401.
    Proves shape is validated before the Argon2id verify, so the route is not
    a cheap password oracle with a free CPU burn attached.
