import { NextResponse } from 'next/server';
import { previewInvite } from '../../../src/lib/api';
import {
  INVITE_CLAIM_COOKIE,
  INVITE_CLAIM_COOKIE_OPTIONS,
  INVITE_CLAIM_MAX_AGE_SECONDS,
} from '../../../src/lib/invite-cookie';

/*
 * THE INVITE LINK, WHICH IS SPENT BY BEING OPENED.
 *
 * A ROUTE HANDLER and not a page, for a reason that is a Next.js constraint
 * rather than a preference: a Server Component cannot set a cookie during
 * render. Exchanging the URL token for a claim means issuing a cookie, so
 * this has to be a handler — which is also why the rendering half now lives
 * one segment up at /invite.
 *
 * What this buys, beyond the exchange itself: after the redirect the URL is
 * `/invite` with no token in it. The proxy access log, the browser's history
 * and any Referer from the accept form are all clean from here on. Only the
 * single request that spent the link ever carried it, and by the time it
 * appears in a log it no longer opens anything.
 *
 * A dead link — unknown, expired, revoked, already accepted, or ALREADY
 * OPENED — redirects to /invite with no cookie, and the page says so. The
 * API answers 410 for all of them with one message; nothing here narrows it.
 */
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }): Promise<NextResponse> {
  const { token } = await params;

  const invite = await previewInvite({ kind: 'link', token });

  // `/invite` renders the dead state when it finds no cookie, so both
  // outcomes land on the same clean URL and a bad link is not distinguishable
  // from a spent one by its address.
  // A RELATIVE Location, and emphatically not `NextResponse.redirect(new
  // URL('/invite', request.url))`.
  //
  // `request.url` in a route handler is normalised to `localhost` — it does
  // not carry the host the visitor actually asked for. Redirecting to an
  // absolute URL built from it sends the browser to a DIFFERENT ORIGIN than
  // the one that just received the Set-Cookie, so the claim cookie is never
  // sent back and the invitation looks dead on arrival. Behind a reverse
  // proxy it is worse than that: real invitees get bounced to `localhost`.
  //
  // A relative Location is resolved by the browser against the address it
  // used, so the origin is preserved whatever the deployment looks like.
  // Verified by hand against the e2e stack, where `request.url` reported
  // `localhost` for a request made to `127.0.0.1` — which is exactly the bug
  // this comment describes, caught by invite-link.spec.ts.
  const response = new NextResponse(null, {
    // 303: the browser must GET the destination. Never cached — a cached
    // redirect would strand a later visitor on someone else's claim cookie.
    status: 303,
    headers: { location: '/invite', 'cache-control': 'no-store' },
  });

  if (invite?.claimToken) {
    response.cookies.set(INVITE_CLAIM_COOKIE, invite.claimToken, {
      ...INVITE_CLAIM_COOKIE_OPTIONS,
      maxAge: INVITE_CLAIM_MAX_AGE_SECONDS,
    });
  }

  return response;
}
