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

/** Whether there is anything at all to show — the same question for either data source. */
export function degreesSectionHasContent({ ownerDegrees, publicDegrees }: DegreesSource): boolean {
  return ownerDegrees !== null ? ownerDegrees.length > 0 : (publicDegrees?.length ?? 0) > 0;
}

/** "1 IN PROGRESS" — PL9/P9's own eyebrow. Works for either shape: both carry `earned`. */
function tallyLine(degrees: ReadonlyArray<{ earned: boolean }>): string {
  const inProgress = degrees.filter((degree) => !degree.earned).length;
  if (inProgress === 0) return `${degrees.length} earned`;
  return `${inProgress} in progress`;
}

export default function DegreesSection({ ownerDegrees, publicDegrees, timezone }: DegreesSectionProps) {
  if (ownerDegrees !== null) {
    return (
      <>
        <p className={styles.tally}>{tallyLine(ownerDegrees)}</p>
        <DegreeList degrees={ownerDegrees} timezone={timezone} />
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
