/*
 * A rubric block, read-only (design §9.4). Two states of the same list:
 *
 *   - Before a submission is returned: just the declared criteria and their
 *     max — "students read the criteria before submitting" (design §9.4,
 *     RubricCriterion's own doc comment: unlike a quiz choice's `correct`,
 *     nothing here is secret).
 *   - Once returned: the same list, plus each criterion's earned score and
 *     a total — the student's score breakdown.
 *
 * The teacher's OWN rubric UI (the scoring form on the grading view) is a
 * separate, interactive component — this one only ever reads.
 */

import type { RubricCriterion, RubricScore } from '../../../../../src/lib/rubric';
import { rubricTotals } from '../../../../../src/lib/rubric';
import styles from './lesson.module.css';

export interface RubricDisplayProps {
  criteria: RubricCriterion[];
  /** Present only once the submission has been returned (design §9.1: rubricScores is empty until then). */
  scores?: RubricScore[];
}

export default function RubricDisplay({ criteria, scores }: RubricDisplayProps) {
  if (criteria.length === 0) return null;

  const scoreByCriterion = new Map((scores ?? []).map((s) => [s.criterion, s]));
  const graded = scores !== undefined && scores.length > 0;
  const totals = graded ? rubricTotals(criteria, scores!) : null;

  return (
    <section className={styles.rubric} aria-labelledby="rubric-heading">
      <h3 className={styles.rubricTitle} id="rubric-heading">
        Rubric{totals ? ` — ${totals.earned} / ${totals.possible}` : ''}
      </h3>
      {!graded ? (
        <p className={styles.rubricHint}>Scored by the teacher once you submit and it is returned.</p>
      ) : null}
      <ul className={styles.rubricList}>
        {criteria.map((criterion) => {
          const score = scoreByCriterion.get(criterion.name);
          return (
            <li key={criterion.name} className={styles.rubricRow}>
              <span className={styles.rubricName}>
                {criterion.name}
                {criterion.track ? <span className={styles.rubricTrack}>{criterion.track}</span> : null}
              </span>
              <span className={styles.rubricScore}>{score ? `${score.points} / ${criterion.max}` : `— / ${criterion.max}`}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
