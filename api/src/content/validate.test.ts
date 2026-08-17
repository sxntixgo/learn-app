import { describe, it, expect } from 'vitest';
import { validateCourseManifest, validateBlocks } from './validate.ts';

function validCourseManifest() {
  return {
    schema: 1,
    slug: 'code-review',
    title: 'Code Review',
    subtitle: 'a course in four lenses',
    description: 'Theory then graded exercises, read through four lenses in sequence.',
    tracks: [
      { id: 'cx', name: 'Complexity', hue: 'blue', blurb: 'Deep vs shallow modules' },
      { id: 'cr', name: 'Craft', hue: 'maroon', blurb: 'Code health over perfection' },
    ],
    tags: ['python', 'js', 'go'],
    modules: [
      {
        id: 'what-review-is-for',
        title: 'What review is for',
        lessons: ['modules/01-what-review-is-for/README.md', 'modules/01-what-review-is-for/ex01-triage.md'],
      },
    ],
  };
}

describe('validateCourseManifest', () => {
  it('accepts a valid manifest', () => {
    const result = validateCourseManifest(validCourseManifest());
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it('accepts a valid manifest with no tracks and no tags', () => {
    const manifest = validCourseManifest();
    delete (manifest as Record<string, unknown>).tracks;
    delete (manifest as Record<string, unknown>).tags;
    const result = validateCourseManifest(manifest);
    expect(result.valid).toBe(true);
  });

  it('rejects a bad hue with a JSON Pointer to the offending track', () => {
    const manifest = validCourseManifest();
    manifest.tracks[0]!.hue = 'purple';

    const result = validateCourseManifest(manifest);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === '/tracks/0/hue')).toBe(true);
  });

  it('rejects a 6th track (max 5)', () => {
    const manifest = validCourseManifest();
    const hues = ['blue', 'teal', 'ochre', 'maroon', 'slate'] as const;
    manifest.tracks = hues.map((hue, i) => ({ id: `t${i}`, name: `Track ${i}`, hue }));
    // Six tracks now — one past the limit.
    manifest.tracks.push({ id: 't5', name: 'Track 5', hue: 'blue' });

    const result = validateCourseManifest(manifest);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === '/tracks')).toBe(true);
  });

  it('rejects a manifest missing required fields', () => {
    const result = validateCourseManifest({ schema: 1, title: 'No slug or modules' });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects schema !== 1', () => {
    const manifest = { ...validCourseManifest(), schema: 2 };
    const result = validateCourseManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === '/schema')).toBe(true);
  });

  it('rejects an unknown top-level property', () => {
    const manifest = { ...validCourseManifest(), degrees: [{ slug: 'x', title: 'X', required: [] }] };
    const result = validateCourseManifest(manifest);
    expect(result.valid).toBe(false);
  });
});

describe('validateBlocks', () => {
  it('accepts a valid prose + code block array', () => {
    const blocks = [
      { type: 'prose', html: '<p>Hello</p>' },
      { type: 'code', lang: 'python', source: 'def f():\n    pass\n' },
    ];
    expect(validateBlocks(blocks)).toEqual({ valid: true, errors: [] });
  });

  it('accepts a code block with annotations', () => {
    const blocks = [
      {
        type: 'code',
        lang: 'python',
        source: 'def review(diff):\n    findings = []\n',
        annotations: [{ line: 1, track: 'cx', body: 'Shallow module: interface as complex as the body' }],
      },
    ];
    expect(validateBlocks(blocks)).toEqual({ valid: true, errors: [] });
  });

  it('accepts a code block with a null lang', () => {
    const blocks = [{ type: 'code', lang: null, source: 'plain fence' }];
    expect(validateBlocks(blocks)).toEqual({ valid: true, errors: [] });
  });

  it('rejects an annotation with neither line nor lines', () => {
    const blocks = [
      {
        type: 'code',
        lang: 'python',
        source: 'x = 1\n',
        annotations: [{ body: 'missing a line anchor' }],
      },
    ];
    const result = validateBlocks(blocks);
    expect(result.valid).toBe(false);
  });

  it('rejects an annotation with both line and lines', () => {
    const blocks = [
      {
        type: 'code',
        lang: 'python',
        source: 'x = 1\ny = 2\n',
        annotations: [{ line: 1, lines: [1, 2], body: 'ambiguous anchor' }],
      },
    ];
    const result = validateBlocks(blocks);
    expect(result.valid).toBe(false);
  });

  it('rejects an unsupported block type (chart is a later phase)', () => {
    const blocks = [{ type: 'chart', kind: 'bar', data: [], caption: 'x' }];
    const result = validateBlocks(blocks);
    expect(result.valid).toBe(false);
  });

  it('rejects a non-array payload', () => {
    const result = validateBlocks({ type: 'prose', html: '<p>not wrapped in an array</p>' });
    expect(result.valid).toBe(false);
  });

  it('reports a JSON Pointer path for a nested error', () => {
    const blocks = [{ type: 'prose', html: '<p>ok</p>' }, { type: 'code', lang: 'js' /* missing source */ }];
    const result = validateBlocks(blocks);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path.startsWith('/1'))).toBe(true);
  });

  describe('quiz blocks (Task A)', () => {
    function validQuiz() {
      return {
        type: 'quiz',
        pass: 0.7,
        questions: [
          {
            prompt: 'Which is a deep module?',
            track: 'cx',
            choices: [{ text: 'shallow' }, { text: 'deep', correct: true }],
          },
        ],
      };
    }

    it('accepts a valid quiz block', () => {
      expect(validateBlocks([validQuiz()])).toEqual({ valid: true, errors: [] });
    });

    it('accepts a quiz question with no track (track is optional)', () => {
      const quiz = validQuiz();
      delete (quiz.questions[0] as { track?: string }).track;
      expect(validateBlocks([quiz])).toEqual({ valid: true, errors: [] });
    });

    it('rejects a question with no correct choice, with a message naming the offending choices array', () => {
      const quiz = validQuiz();
      quiz.questions[0]!.choices = [{ text: 'a' }, { text: 'b' }];
      const result = validateBlocks([quiz]);
      expect(result.valid).toBe(false);
      expect(
        result.errors.some((e) => e.path === '/0/questions/0/choices' && /contain/i.test(e.message)),
      ).toBe(true);
    });

    it('rejects pass outside [0, 1]', () => {
      const quiz = validQuiz();
      quiz.pass = 1.5;
      const result = validateBlocks([quiz]);
      expect(result.valid).toBe(false);
    });

    it('rejects a quiz with no questions', () => {
      const quiz = validQuiz();
      quiz.questions = [];
      const result = validateBlocks([quiz]);
      expect(result.valid).toBe(false);
    });

    it('rejects a choice with an unknown property', () => {
      const quiz = validQuiz();
      (quiz.questions[0]!.choices[1] as { bogus?: string }).bogus = 'nope';
      const result = validateBlocks([quiz]);
      expect(result.valid).toBe(false);
    });
  });
});
