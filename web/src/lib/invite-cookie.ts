/*
 * WHERE AN INVITATION LIVES ONCE THE LINK HAS BEEN OPENED.
 *
 * The token in an invite URL is the credential (§13), and a URL is the worst
 * place to keep one: the reverse proxy access-logs the path, the browser
 * keeps it in history, and it rides along in Referer. So the link is spent on
 * the FIRST request — `/invite/[token]/route.ts` exchanges it for a
 * short-lived claim token and lands the visitor on `/invite`, with no token
 * in the URL from that point on. A link recovered from a log afterwards is
 * already dead.
 *
 * The claim then has to live somewhere for the few minutes it takes to fill
 * in a registration form. httpOnly so no script can read it, path-scoped to
 * /invite so it is not attached to any other request on this origin, and
 * short-lived so it is a continuation of one flow rather than a second
 * standing credential.
 */

/** Name of the cookie carrying the claim token. */
export const INVITE_CLAIM_COOKIE = 'learn_invite';

/**
 * How long the browser keeps it. Matches CLAIM_TOKEN_TTL_MINUTES on the API
 * side — the server is the authority and rejects a stale claim regardless,
 * but a cookie that outlives its own token only produces a confusing 410.
 */
export const INVITE_CLAIM_MAX_AGE_SECONDS = 30 * 60;

/**
 * Cookie attributes. `sameSite: 'lax'` and not 'strict' on purpose: an invite
 * link is followed FROM somewhere else (a mail client, a chat window), and
 * 'strict' would withhold the cookie on exactly that first cross-site
 * navigation back from /login.
 */
export const INVITE_CLAIM_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/invite',
} as const;
