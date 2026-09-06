import { describe, it, expect } from 'vitest';
import { checkpointEyebrow, quizPassThreshold } from './quiz';

describe('quizPassThreshold', () => {
  it('matches the artboard example: 2 questions, must pass all of them', () => {
    // PL6/P7's own quiz: pass: 1 (fraction), 2 questions -> "PASS AT 2".
    expect(quizPassThreshold(1, 2)).toBe(2);
  });

  it('rounds a fractional threshold up to the next whole question', () => {
    // 70% of 10 is exactly 7 -- the server's `score >= pass` passes at
    // correctCount 7, not 6.
    expect(quizPassThreshold(0.7, 10)).toBe(7);
    // 70% of 2 is 1.4 -- 1 correct answer is only 50%, so 2 are required.
    expect(quizPassThreshold(0.7, 2)).toBe(2);
    // 70% of 3 is 2.1 -- 2 correct is 66.7%, under threshold, so all 3 are required.
    expect(quizPassThreshold(0.7, 3)).toBe(3);
  });

  it('clamps to the question count and to zero', () => {
    expect(quizPassThreshold(0, 5)).toBe(0);
    expect(quizPassThreshold(1, 1)).toBe(1);
    expect(quizPassThreshold(0.5, 4)).toBe(2);
  });

  it('treats a lesson with no questions as needing none', () => {
    expect(quizPassThreshold(1, 0)).toBe(0);
  });
});

describe('checkpointEyebrow', () => {
  it('renders the artboard string (PL6/P7: "CHECKPOINT · 2 QUESTIONS · PASS AT 2")', () => {
    // .eyebrow applies text-transform: uppercase, so sentence case here is
    // the source of truth -- the browser does the capitalising.
    expect(checkpointEyebrow(2, 1)).toBe('Checkpoint · 2 questions · Pass at 2');
  });

  it('singularizes a one-question checkpoint', () => {
    expect(checkpointEyebrow(1, 1)).toBe('Checkpoint · 1 question · Pass at 1');
  });
});
