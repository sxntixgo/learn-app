/*
 * The profile's Degrees panel (PL9/P9: "1 IN PROGRESS", a not-started degree
 * shown with its prerequisites) — the same owner/public split as
 * BadgesSection.tsx beside it, and for the same reason.
 *
 * OWNER: `DegreeProgress[]` from `/api/v1/me/degrees`, via the pre-existing
 * `DegreeList` component — full per-requirement detail (`required`,
 * `electives`, `satisfiable`), including a degree at 0% with every
 * prerequisite pill still unchecked. That is the one thing the public
 * payload cannot show: `api/src/profile/serialize.ts` documents that the
 * per-requirement breakdown is "instance curriculum detail rather than
 * something the account holder opted to publish about themselves", so
 * `ProfileDegree` carries only `earned`/`percent`, never `required`.
 *
 * EVERYONE ELSE: `ProfileDegree[]` from `sections.degrees` — earned or in
 * progress, with a percent, but no prerequisite list. Rendered here with the
 * same earned/locked structural language (solid vs. dashed border, a status
 * word) minus the requirement pills the data does not carry.
 *
 * WHY `ownerDegrees` IS FILTERED BEFORE IT IS TREATED AS CONTENT.
 * `/api/v1/me/degrees` (`listDegreeProgress`, api/src/progression/views.ts)
 * joins EVERY row of `degrees` against the caller — degrees are
 * instance-wide curriculum objects, not enrolments, so there is no per-user
 * scoping in that query at all. Read naively, that means the OWNER branch
 * below is never actually empty once a single degree exists ANYWHERE on the
 * instance: an account that has never touched any of its required courses
 * still gets a "0% complete" entry. That is precisely the fixture collision
 * profile-empty.spec.ts exists to catch (`avatarUser`, an account with
 * nothing in it) and viewport.spec.ts / a11y.spec.ts share (`viewportUser`,
 * viewing its own profile as owner) — see tools/src/e2e-seed.ts's own
 * comment on `E2E_DEGREE_SLUG`.
 *
 * `hasRealProgress` is deliberately narrower than the artboard's "a
 * not-started degree with its prerequisites" (PL9/P9) — a genuinely
 * 0%-but-relevant degree (the owner is enrolled in one of its courses but
 * has finished nothing) would also be hidden by this rule, and nothing in
 * this suite proves that browser case yet. Telling "0% and never touched
 * this at all" apart from "0% but actually pursuing it" needs enrolment
 * data this payload does not carry (`DegreeRequirement` has
 * `completed`/`imported`, not `enrolled`) — a real follow-up, not a
 * shortcut taken here.
 */

import type { DegreeProgress, ProfileDegree } from '../../../src/lib/api';
import { formatAwardedAt } from '../../../src/lib/badges';
import DegreeList from './DegreeList';
import styles from './badges.module.css';

export interface DegreesSectionProps {
  /** Earned + full requirement detail, present only when this viewer IS the profile's owner. */
  ownerDegrees: DegreeProgress[] | null;
  /** Earned/percent only — every viewer's payload, including the owner's, but the owner path above supersedes it. */
  publicDegrees: ProfileDegree[] | undefined;
  timezone: string;
}

type DegreesSource = Pick<DegreesSectionProps, 'ownerDegrees' | 'publicDegrees'>;

/** Earned, or with some real percent toward it — never a degree the owner has never touched. */
function hasRealProgress(degree: DegreeProgress): boolean {
  return degree.earned || degree.percent > 0;
}

/** Whether there is anything at all to show — the same question for either data source. */
export function degreesSectionHasContent({ ownerDegrees, publicDegrees }: DegreesSource): boolean {
  return ownerDegrees !== null ? ownerDegrees.some(hasRealProgress) : (publicDegrees?.length ?? 0) > 0;
}

/** "1 IN PROGRESS" — PL9/P9's own eyebrow. Works for either shape: both carry `earned`. */
function tallyLine(degrees: ReadonlyArray<{ earned: boolean }>): string {
  const inProgress = degrees.filter((degree) => !degree.earned).length;
  if (inProgress === 0) return `${degrees.length} earned`;
  return `${inProgress} in progress`;
}

export default function DegreesSection({ ownerDegrees, publicDegrees, timezone }: DegreesSectionProps) {
  if (ownerDegrees !== null) {
    // Filtered the same way degreesSectionHasContent decided to render this
    // section at all — a degree the owner has never touched does not
    // belong in the tally or the list either, once one exists elsewhere.
    const relevant = ownerDegrees.filter(hasRealProgress);
    return (
      <>
        <p className={styles.tally}>{tallyLine(relevant)}</p>
        <DegreeList degrees={relevant} timezone={timezone} />
      </>
    );
  }

  const degrees = publicDegrees ?? [];
  return (
    <>
      <p className={styles.tally}>{tallyLine(degrees)}</p>
      <ul className={styles.degrees}>
        {degrees.map((degree) => {
          const awardedAt = formatAwardedAt(degree.awardedAt, timezone);
          return (
            <li key={degree.slug} className={degree.earned ? styles.degreeEarned : styles.degreeLocked}>
              <div className={styles.degreeHead}>
                <h3 className={styles.degreeTitle}>{degree.title}</h3>
                <p className={styles.status}>
                  {degree.earned ? `Earned${awardedAt ? ` · ${awardedAt}` : ''}` : `${degree.percent}% complete`}
                </p>
              </div>
              {degree.description ? <p className={styles.description}>{degree.description}</p> : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}
