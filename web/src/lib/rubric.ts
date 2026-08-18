/*
 * Rubric criteria and scoring — the pure half of the grading form (design
 * §9.4/§9.1, Phase 9). No React, no DOM: same reasoning as annotations.ts,
 * so the "is this score set complete and in range" logic is unit-tested
 * without mounting a component.
 *
 * THE RULE THIS SERVES: api/src/routes/submissions.ts's POST .../grade
 * refuses a `rubricScores` array that does not cover every declared
 * criterion exactly once (400) — there is no partial-score write. Losing a
 * teacher's typed-in scores to that refusal is the bug design review called
 * out by name, so `parseRubricInputs` validates client-side BEFORE any
 * network call, and its caller (GradingForm) never clears form state on a
 * rejection either way — the server's own message is the backstop, not the
 * only line of defence.
 */

import type { components } from './api-types';

type Block = components['schemas']['Block'];
export type RubricBlock = Extract<Block, { type: 'rubric' }>;
export type RubricCriterion = RubricBlock['criteria'][number];
export type RubricScore = components['schemas']['RubricScore'];

/** The exercise's declared rubric criteria, read from its snapshot — never the live lesson (design §9.4). Empty when the exercise declares no rubric block at all (a prose-answer exercise, say). */
export function findRubricCriteria(blocks: readonly Block[]): RubricCriterion[] {
  const block = blocks.find((b): b is RubricBlock => b.type === 'rubric');
  return block ? block.criteria : [];
}

/** Earned/possible totals for the score breakdown a returned submission shows the student. */
export function rubricTotals(
  criteria: readonly RubricCriterion[],
  scores: readonly RubricScore[]
): { earned: number; possible: number } {
  const possible = criteria.reduce((sum, c) => sum + c.max, 0);
  const earned = scores.reduce((sum, s) => sum + s.points, 0);
  return { earned, possible };
}

/** One text-input value per criterion, keyed by criterion name — the shape a <form>'s controlled inputs use. */
export type RubricScoreInputs = Record<string, string>;

/**
 * Seeds the rubric form from any scores already on the submission (a
 * re-grade — db/migrations/0012_rubric_scores.sql's header explains why
 * re-grading is allowed at all). A criterion with no existing score is left
 * out (not defaulted to "0"): a blank field is what makes an unscored
 * criterion visibly unscored, rather than silently reading as a real zero.
 */
export function seedRubricInputs(criteria: readonly RubricCriterion[], scores: readonly RubricScore[]): RubricScoreInputs {
  const byName = new Map(scores.map((s) => [s.criterion, s] as const));
  const inputs: RubricScoreInputs = {};
  for (const criterion of criteria) {
    const existing = byName.get(criterion.name);
    if (existing) inputs[criterion.name] = String(existing.points);
  }
  return inputs;
}

export type ParsedRubricScores =
  | { ok: true; scores: { criterion: string; points: number }[] }
  | { ok: false; problems: Record<string, string> };

/**
 * Validates a rubric form's raw string inputs against the declared criteria
 * BEFORE any network call — every criterion must be present, numeric, and
 * within [0, max], matching matchRubricScores' own rules server-side (Task
 * C) so the 400 this is meant to prevent is the rare case, not the normal
 * path. `problems` is keyed by criterion name so the form can show each
 * field's own message rather than one generic banner.
 */
export function parseRubricInputs(criteria: readonly RubricCriterion[], inputs: RubricScoreInputs): ParsedRubricScores {
  if (criteria.length === 0) return { ok: true, scores: [] };

  const problems: Record<string, string> = {};
  const scores: { criterion: string; points: number }[] = [];

  for (const criterion of criteria) {
    const raw = (inputs[criterion.name] ?? '').trim();
    if (raw === '') {
      problems[criterion.name] = 'Score this criterion before returning.';
      continue;
    }
    const points = Number(raw);
    if (!Number.isFinite(points) || points < 0 || points > criterion.max) {
      problems[criterion.name] = `Enter a number between 0 and ${criterion.max}.`;
      continue;
    }
    scores.push({ criterion: criterion.name, points });
  }

  if (Object.keys(problems).length > 0) return { ok: false, problems };
  return { ok: true, scores };
}
