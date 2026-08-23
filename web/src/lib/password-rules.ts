/**
 * Password rules the FORM enforces, kept in step with the API by test.
 *
 * The server is the authority — api/src/auth/account-fields.ts, reached
 * through POST /api/v1/auth/password — and web cannot import it: CLAUDE.md
 * rule 1 keeps the two apart, and the generated client types erase
 * `minLength` because it is a constraint rather than a value.
 *
 * So the number is duplicated, deliberately, and password-rules.test.ts reads
 * it back out of openapi/openapi.yaml and fails if the two disagree. That is
 * the same trick heatmap.test.ts uses on the CSS and docker-stack.test.ts
 * uses on the Dockerfiles: when a value has to exist twice, the second copy
 * is checked against the first rather than trusted.
 *
 * Without it the form keeps promising the old rule after the server moves —
 * `minLength` lets the browser submit, the hint tells the reader the wrong
 * thing, and the API rejects it.
 */
export const MIN_PASSWORD_LENGTH = 12;
