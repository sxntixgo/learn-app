import { describe, expect, it } from 'vitest';
import {
  findRubricCriteria,
  parseRubricInputs,
  rubricTotals,
  seedRubricInputs,
  type RubricBlock,
  type RubricCriterion,
  type RubricScore,
} from './rubric';

const criteria: RubricCriterion[] = [
  { name: 'Spotted the shallow module', max: 5, track: 'cx' },
  { name: 'Review tone', max: 3 },
];

const rubricBlock: RubricBlock = { type: 'rubric', criteria };

describe('findRubricCriteria', () => {
  it('finds the rubric block among other block types and returns its criteria', () => {
    const blocks = [{ type: 'prose', html: '<p>hi</p>' } as const, rubricBlock];
    expect(findRubricCriteria(blocks)).toEqual(criteria);
  });

  it('returns an empty array when the exercise declares no rubric block', () => {
    const blocks = [{ type: 'prose', html: '<p>hi</p>' } as const];
    expect(findRubricCriteria(blocks)).toEqual([]);
  });
});

describe('rubricTotals', () => {
  it('sums declared max and earned points', () => {
    const scores: RubricScore[] = [
      { id: '1', criterion: 'Spotted the shallow module', points: 4, max: 5, track: 'cx', scoredBy: 't1', createdAt: 'x', updatedAt: 'x' },
      { id: '2', criterion: 'Review tone', points: 3, max: 3, track: null, scoredBy: 't1', createdAt: 'x', updatedAt: 'x' },
    ];
    expect(rubricTotals(criteria, scores)).toEqual({ earned: 7, possible: 8 });
  });

  it('is zero/zero with no criteria and no scores', () => {
    expect(rubricTotals([], [])).toEqual({ earned: 0, possible: 0 });
  });
});

describe('seedRubricInputs', () => {
  it('seeds a string per criterion that already has a score', () => {
    const scores: RubricScore[] = [
      { id: '1', criterion: 'Review tone', points: 2, max: 3, track: null, scoredBy: 't1', createdAt: 'x', updatedAt: 'x' },
    ];
    expect(seedRubricInputs(criteria, scores)).toEqual({ 'Review tone': '2' });
  });

  it('leaves an unscored criterion out entirely — never defaults to "0"', () => {
    expect(seedRubricInputs(criteria, [])).toEqual({});
  });
});

describe('parseRubricInputs', () => {
  it('is trivially valid when the exercise declares no rubric', () => {
    expect(parseRubricInputs([], {})).toEqual({ ok: true, scores: [] });
  });

  it('parses a complete, in-range set', () => {
    const result = parseRubricInputs(criteria, { 'Spotted the shallow module': '4', 'Review tone': '3' });
    expect(result).toEqual({
      ok: true,
      scores: [
        { criterion: 'Spotted the shallow module', points: 4 },
        { criterion: 'Review tone', points: 3 },
      ],
    });
  });

  it('refuses a missing criterion without discarding the ones that were filled in', () => {
    const result = parseRubricInputs(criteria, { 'Spotted the shallow module': '4' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.problems).toEqual({ 'Review tone': 'Score this criterion before returning.' });
  });

  it('refuses a score above the criterion max', () => {
    const result = parseRubricInputs(criteria, { 'Spotted the shallow module': '9', 'Review tone': '1' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.problems['Spotted the shallow module']).toMatch(/between 0 and 5/);
  });

  it('refuses a negative or non-numeric score', () => {
    const negative = parseRubricInputs(criteria, { 'Spotted the shallow module': '-1', 'Review tone': '1' });
    const nonNumeric = parseRubricInputs(criteria, { 'Spotted the shallow module': 'abc', 'Review tone': '1' });
    expect(negative.ok).toBe(false);
    expect(nonNumeric.ok).toBe(false);
  });

  it('reports every problem at once rather than stopping at the first', () => {
    const result = parseRubricInputs(criteria, {});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(Object.keys(result.problems).sort()).toEqual(['Review tone', 'Spotted the shallow module']);
  });
});
