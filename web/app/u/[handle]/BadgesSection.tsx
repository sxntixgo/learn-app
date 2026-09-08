/*
 * The profile's Badges panel (PL9/P9: "3 OF 9", locked states included) —
 * one component, TWO DATA SOURCES, because the API publishes two different
 * shapes of badge and this is the one place that has to reconcile them.
 *
 * OWNER: `BadgeProgress[]` from `/api/v1/me/badges` — earned AND locked,
 * with the scalar progress toward each. Only the signed-in actor can ever
 * see this for themselves (api/src/routes/me.ts), so `page.tsx` fetches it
 * only when `profile.viewer === 'owner'` and hands it here as `ownerBadges`.
 * This is what lets the artboard's locked tiles render at all, and it needs
 * no new API surface — `/me/badges` already existed and was already tested,
 * just never rendered anywhere once the old dashboard was retired.
 *
 * EVERYONE ELSE: `ProfileBadge[]` from the profile payload itself
 * (`sections.badges`) — earned only. `api/src/profile/load.ts`'s own
 * comment is explicit about why: "A profile shows what you have, not what
 * you are missing" (design §11). There is no locked state to show a
 * stranger, or even the account holder's own signed-in friend: nobody but
 * the owner can ever see a count of what is still locked, because the API
 * has never computed or published one for anyone else. That is a real gap
 * against the artboard's "3 OF 9" for a non-owner viewer — recorded in the
 * Phase 4 outcome rather than papered over here.
 *
 * `badgesSectionHasContent` mirrors src/lib/profile-sections.ts's
 * `sectionHasContent`, but reads whichever of the two sources this viewer
 * actually gets, so `page.tsx` can decide whether to render the heading at
 * all — the same "absent vs. empty" rule the rest of the page follows.
 */

import type { BadgeProgress, ProfileBadge } from '../../../src/lib/api';
import { formatAwardedAt } from '../../../src/lib/badges';
import BadgeShelf from './BadgeShelf';
import styles from './badges.module.css';

export interface BadgesSectionProps {
  /** Earned + locked, present only when this viewer IS the profile's owner. */
  ownerBadges: BadgeProgress[] | null;
  /** Earned only — every viewer's payload, including the owner's, but the owner path above supersedes it. */
  publicBadges: ProfileBadge[] | undefined;
  timezone: string;
}

type BadgesSource = Pick<BadgesSectionProps, 'ownerBadges' | 'publicBadges'>;

/**
 * Whether there is anything at all to show — the same question for either data
 * source, but NOT the same test.
 *
 * `/api/v1/me/badges` enumerates every badge definition on the instance
 * against the caller, earned or not — there is no per-user scoping in that
 * query, because a badge is instance-wide curriculum, not a possession. So
 * `ownerBadges.length` is "how many badges exist here", never "how many this
 * account has", and testing it would put a "0 of 9" section on EVERY owner's
 * profile the moment anyone seeds a badge — including an account with nothing
 * in it, which is exactly what `profile-empty.spec.ts` exists to catch. The
 * degrees half of this page hit precisely that and is guarded by
 * `hasRealProgress`; this is the same guard, one section over.
 *
 * Unlike degrees, nothing is hidden by it. This decides only whether the
 * SECTION appears; once it does, `BadgeShelf` still renders the locked badges
 * alongside the earned ones, and the tally is still "3 of 9" — PL9/P9's own
 * eyebrow. An owner with at least one badge sees everything the artboard
 * draws. An owner with none sees no section, which is what an empty profile
 * means.
 *
 * The public branch needs no equivalent: `ProfileBadge` is earned-only by
 * design (`api/src/profile/load.ts` — "a profile shows what you have, not
 * what you are missing"), so a non-empty list there already means real
 * badges.
 */
export function badgesSectionHasContent({ ownerBadges, publicBadges }: BadgesSource): boolean {
  return ownerBadges !== null
    ? ownerBadges.some((badge) => badge.earned)
    : (publicBadges?.length ?? 0) > 0;
}

export default function BadgesSection({ ownerBadges, publicBadges, timezone }: BadgesSectionProps) {
  // The richer, owner-only view: earned and locked both, via BadgeShelf —
  // the component this page absorbed unchanged from the old dashboard.
  if (ownerBadges !== null) {
    const earnedCount = ownerBadges.filter((badge) => badge.earned).length;
    return (
      <>
        {/*
         * PL9/P9's own eyebrow — "3 OF 9" — is a real tally, not a fixed
         * string: only the owner has a denominator at all, since nobody
         * else's payload carries the badges they have NOT earned.
         */}
        <p className={styles.tally}>
          {earnedCount} of {ownerBadges.length}
        </p>
        <BadgeShelf badges={ownerBadges} timezone={timezone} />
      </>
    );
  }

  // The public view: earned only, one visual state. Still built from
  // badges.module.css's earned card — solid border, filled seal, "Earned" —
  // so a stranger's badge list and the owner's earned tiles never disagree
  // about what "earned" looks like.
  const badges = publicBadges ?? [];
  return (
    <ul className={styles.grid}>
      {badges.map((badge) => {
        const awardedAt = formatAwardedAt(badge.awardedAt, timezone);
        return (
          <li key={badge.slug} className={styles.cardEarned}>
            <div className={styles.head}>
              <span className={styles.sealEarned} aria-hidden="true" />
              <h3 className={styles.title}>{badge.title}</h3>
            </div>
            <p className={styles.status}>Earned</p>
            {badge.description ? <p className={styles.description}>{badge.description}</p> : null}
            {awardedAt !== null ? (
              <p className={styles.awarded}>
                <time dateTime={badge.awardedAt ?? undefined}>{awardedAt}</time>
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
