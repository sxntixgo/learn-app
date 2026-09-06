import { describe, it, expect } from 'vitest';
import { codeLineCount, hashSnapshot, presentBlocks } from './present.ts';

// ---------------------------------------------------------------------------
// present.ts is the ONE chokepoint that keeps a quiz's answer key out of page
// source (design §9.1 — quizzes are machine-scored server-side), and it is
// shared by two callers that must agree byte for byte: routes/courses.ts
// serializing a lesson, and routes/submissions.ts freezing the snapshot a
// teacher grades a month later. So the tests below are in two halves.
//
// The first half is the strip itself. The second, and the reason this file
// exists at all, is the DEFENSIVE half: `blocks` arrives as `unknown` off a
// jsonb column, and every shape this function does not recognise has to come
// back unchanged rather than throw. A TypeError here is a 500 on every lesson
// page in the instance, triggered by one malformed row — which is a worse
// outcome than the mis-shaped block it was reacting to. Each case below feeds
// it a shape a hand-edited or half-migrated row could really hold.
// ---------------------------------------------------------------------------

/** A stored quiz block, complete with the `correct` flags the browser must never see. */
function storedQuiz(): unknown {
  return {
    type: 'quiz',
    pass: 0.7,
    questions: [
      {
        prompt: 'Which one?',
        track: 'theory',
        choices: [
          { text: 'right', correct: true },
          { text: 'wrong' },
        ],
      },
    ],
  };
}

describe('presentBlocks', () => {
  it('strips `correct` from every quiz choice while keeping everything a reader needs', () => {
    const [block] = presentBlocks([storedQuiz()]) as Array<{
      type: string;
      pass: number;
      questions: Array<{ prompt: string; track?: string; choices: Array<Record<string, unknown>> }>;
    }>;

    expect(block!.type).toBe('quiz');
    expect(block!.pass).toBe(0.7);
    expect(block!.questions[0]!.prompt).toBe('Which one?');
    expect(block!.questions[0]!.track).toBe('theory');
    expect(block!.questions[0]!.choices).toEqual([{ text: 'right' }, { text: 'wrong' }]);
    for (const choice of block!.questions[0]!.choices) {
      expect(choice).not.toHaveProperty('correct');
    }
  });

  it('does not mutate the block it was given — the row the scoring route reads still has the answers', () => {
    // routes/quiz.ts scores against the RAW row on the same request the reader
    // is served from. If stripping mutated in place, whichever of the two ran
    // second would silently see an answerless quiz, and every submission would
    // score zero.
    const original = storedQuiz() as { questions: Array<{ choices: Array<{ correct?: boolean }> }> };
    presentBlocks([original]);
    expect(original.questions[0]!.choices[0]!.correct).toBe(true);
  });

  it('passes a non-quiz block through unchanged', () => {
    const prose = { type: 'prose', html: '<p>hello</p>' };
    const code = { type: 'code', lang: 'ts', source: 'const a = 1;' };
    expect(presentBlocks([prose, code])).toEqual([prose, code]);
  });

  it('returns an empty array unchanged', () => {
    expect(presentBlocks([])).toEqual([]);
  });

  // -- the defensive half ----------------------------------------------------

  it('returns a non-array `blocks` as it found it rather than throwing', () => {
    // `lessons.blocks` is jsonb: nothing in the column type stops a row holding
    // an object or a null, and a lesson page must still render (or 404) rather
    // than 500 because one row is mis-shaped.
    expect(presentBlocks(null)).toBeNull();
    expect(presentBlocks(undefined)).toBeUndefined();
    expect(presentBlocks({ type: 'quiz' })).toEqual({ type: 'quiz' });
    expect(presentBlocks('not blocks')).toBe('not blocks');
  });

  it('passes a null or primitive entry inside the array through, and keeps stripping the rest', () => {
    const result = presentBlocks([null, 'stray', storedQuiz()]) as unknown[];
    expect(result[0]).toBeNull();
    expect(result[1]).toBe('stray');
    expect(JSON.stringify(result[2])).not.toContain('correct');
  });

  it('leaves a quiz block whose `questions` is not an array completely alone', () => {
    const broken = { type: 'quiz', pass: 0.5, questions: 'three of them' };
    expect(presentBlocks([broken])).toEqual([broken]);
  });

  it('leaves a question that is not an object alone, and strips its well-formed siblings', () => {
    const result = presentBlocks([
      {
        type: 'quiz',
        pass: 0.5,
        questions: [null, { prompt: 'ok', choices: [{ text: 'a', correct: true }] }],
      },
    ]) as Array<{ questions: unknown[] }>;

    expect(result[0]!.questions[0]).toBeNull();
    expect(result[0]!.questions[1]).toEqual({ prompt: 'ok', choices: [{ text: 'a' }] });
  });

  it('leaves a question whose `choices` is not an array alone, keeping the rest of the question', () => {
    const question = { prompt: 'ok', choices: { text: 'a', correct: true } };
    const result = presentBlocks([{ type: 'quiz', pass: 0.5, questions: [question] }]) as Array<{
      questions: unknown[];
    }>;
    expect(result[0]!.questions[0]).toEqual(question);
  });

  it('leaves a choice that is not an object alone rather than spreading a string into one', () => {
    const result = presentBlocks([
      { type: 'quiz', pass: 0.5, questions: [{ prompt: 'ok', choices: [null, 'a', { text: 'b', correct: true }] }] },
    ]) as Array<{ questions: Array<{ choices: unknown[] }> }>;

    expect(result[0]!.questions[0]!.choices[0]).toBeNull();
    expect(result[0]!.questions[0]!.choices[1]).toBe('a');
    expect(result[0]!.questions[0]!.choices[2]).toEqual({ text: 'b' });
  });
});

describe('hashSnapshot', () => {
  it('is stable for identical bytes and different for a one-character change', () => {
    const json = JSON.stringify({ type: 'exercise', prompt: 'Write a parser' });
    expect(hashSnapshot(json)).toBe(hashSnapshot(json));
    expect(hashSnapshot(json)).not.toBe(hashSnapshot(json.replace('parser', 'Parser')));
  });

  it('hashes the bytes, NOT a normalised object — reordered keys are a different snapshot', () => {
    // Deliberate (see the doc comment): the snapshot is written once and never
    // rewritten, so the hash describes the exact column contents. A normaliser
    // would only create a way for the hash and the bytes to disagree.
    expect(hashSnapshot('{"a":1,"b":2}')).not.toBe(hashSnapshot('{"b":2,"a":1}'));
  });

  it('produces a 64-character lowercase hex sha256', () => {
    expect(hashSnapshot('')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('codeLineCount', () => {
  // Every stored annotation anchor is expressed in these line numbers, and the
  // browser (web/src/lib/annotations.ts) counts them its own way. A count that
  // disagreed by one would reject a legitimate last-line annotation, or accept
  // one that renders nowhere.
  it('counts a single line as one, with or without a trailing newline', () => {
    expect(codeLineCount('const a = 1;')).toBe(1);
    expect(codeLineCount('const a = 1;\n')).toBe(1);
  });

  it('does not count the empty span shiki emits after a trailing newline', () => {
    expect(codeLineCount('a\nb\nc\n')).toBe(3);
    expect(codeLineCount('a\nb\nc')).toBe(3);
  });

  it('keeps a deliberate blank line at the end when the source ends in two newlines', () => {
    expect(codeLineCount('a\n\n')).toBe(2);
  });

  it('never returns zero, so an empty source still has a line 1 to anchor to', () => {
    expect(codeLineCount('')).toBe(1);
    expect(codeLineCount('\n')).toBe(1);
  });
});
