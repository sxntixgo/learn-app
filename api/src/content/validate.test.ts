import { describe, it, expect } from 'vitest';
import { BADGE_CRITERION_TYPES, validateBadgeCriteria, validateCourseManifest, validateBlocks } from './validate.ts';

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
    // This used `degrees` as its example until Phase 11 made degrees a real
    // top-level key, at which point the test failed for being out of date
    // rather than for a regression. Use a name nothing will ever claim.
    const manifest = { ...validCourseManifest(), notAThingTheSchemaKnows: true };
    const result = validateCourseManifest(manifest);
    expect(result.valid).toBe(false);
  });

  it('accepts the degrees key now that Phase 11 declares it', () => {
    const manifest = {
      ...validCourseManifest(),
      degrees: [{ slug: 'secure-code-review', title: 'Secure Code Review', required: [] }],
    };
    expect(validateCourseManifest(manifest).valid).toBe(true);
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

  it('rejects an unsupported block type (callout is a later phase)', () => {
    const blocks = [{ type: 'callout', variant: 'warning', html: '<p>x</p>' }];
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

  describe('rubric blocks (design §9.4, Task A)', () => {
    function validRubric() {
      return {
        type: 'rubric',
        criteria: [
          { name: 'Spotted the shallow module', max: 5, track: 'cx' },
          { name: 'Review tone', max: 3 },
        ],
      };
    }

    it('accepts a valid rubric block', () => {
      expect(validateBlocks([validRubric()])).toEqual({ valid: true, errors: [] });
    });

    it('accepts a criterion with no track (track is optional)', () => {
      const rubric = validRubric();
      expect(validateBlocks([rubric])).toEqual({ valid: true, errors: [] });
    });

    it('rejects a rubric with no criteria', () => {
      const rubric = validRubric();
      rubric.criteria = [];
      const result = validateBlocks([rubric]);
      expect(result.valid).toBe(false);
    });

    it('rejects a criterion missing a name', () => {
      const rubric = validRubric();
      delete (rubric.criteria[0] as { name?: string }).name;
      const result = validateBlocks([rubric]);
      expect(result.valid).toBe(false);
    });

    it('rejects a criterion missing max', () => {
      const rubric = validRubric();
      delete (rubric.criteria[0] as { max?: number }).max;
      const result = validateBlocks([rubric]);
      expect(result.valid).toBe(false);
    });

    it('rejects max <= 0', () => {
      const rubric = validRubric();
      rubric.criteria[0]!.max = 0;
      const result = validateBlocks([rubric]);
      expect(result.valid).toBe(false);
    });

    it('rejects a criterion with an unknown property', () => {
      const rubric = validRubric();
      (rubric.criteria[0] as { bogus?: string }).bogus = 'nope';
      const result = validateBlocks([rubric]);
      expect(result.valid).toBe(false);
    });

    it('strips nothing at the schema level either: every field round-trips', () => {
      // Companion to parse.test.ts's assertion of the same thing — the
      // schema does not merely tolerate extra fields, it requires exactly
      // the ones a course author wrote, with additionalProperties: false.
      const rubric = validRubric();
      const result = validateBlocks([rubric]);
      expect(result).toEqual({ valid: true, errors: [] });
      expect(rubric.criteria[0]).toEqual({ name: 'Spotted the shallow module', max: 5, track: 'cx' });
    });
  });

  describe('chart blocks (design §6.3/§14.1, Task A)', () => {
    function validChart() {
      return {
        type: 'chart',
        kind: 'bar',
        caption: 'Lessons completed per module',
        data: [
          { label: 'MCP servers', value: 5 },
          { label: 'Agents', value: 6 },
        ],
      };
    }

    it('accepts a valid bar chart', () => {
      expect(validateBlocks([validChart()])).toEqual({ valid: true, errors: [] });
    });

    it('accepts a valid line chart', () => {
      const chart = validChart();
      chart.kind = 'line';
      expect(validateBlocks([chart])).toEqual({ valid: true, errors: [] });
    });

    it('rejects a chart with no data (empty array), naming the data field', () => {
      const chart = validChart();
      chart.data = [];
      const result = validateBlocks([chart]);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.path === '/0/data')).toBe(true);
    });

    it('rejects a chart missing the data field entirely', () => {
      const chart = validChart() as Record<string, unknown>;
      delete chart.data;
      const result = validateBlocks([chart]);
      expect(result.valid).toBe(false);
    });

    it('rejects a non-numeric value, naming the offending datum', () => {
      const chart = validChart();
      (chart.data[0] as { value: unknown }).value = 'five';
      const result = validateBlocks([chart]);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.path === '/0/data/0/value')).toBe(true);
    });

    it('rejects an unknown chart kind, naming the kind field', () => {
      const chart = validChart() as { kind: string };
      chart.kind = 'pie';
      const result = validateBlocks([chart]);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.path === '/0/kind')).toBe(true);
    });

    it('rejects a chart with no caption', () => {
      const chart = validChart() as Record<string, unknown>;
      delete chart.caption;
      const result = validateBlocks([chart]);
      expect(result.valid).toBe(false);
    });

    it('rejects a datum missing a label', () => {
      const chart = validChart();
      delete (chart.data[0] as { label?: string }).label;
      const result = validateBlocks([chart]);
      expect(result.valid).toBe(false);
    });

    it('rejects a datum with an unknown property', () => {
      const chart = validChart();
      (chart.data[0] as { bogus?: string }).bogus = 'nope';
      const result = validateBlocks([chart]);
      expect(result.valid).toBe(false);
    });
  });

  describe('figure blocks (design §6.3, Task B)', () => {
    function validFigure() {
      return {
        type: 'figure',
        svg: '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="currentColor" /></svg>',
        caption: 'A circle',
      };
    }

    it('accepts a valid figure block', () => {
      expect(validateBlocks([validFigure()])).toEqual({ valid: true, errors: [] });
    });

    it('rejects a figure with no caption', () => {
      const figure = validFigure() as Record<string, unknown>;
      delete figure.caption;
      const result = validateBlocks([figure]);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.path === '/0')).toBe(true);
    });

    it('rejects a figure with an empty caption', () => {
      const figure = validFigure();
      figure.caption = '';
      const result = validateBlocks([figure]);
      expect(result.valid).toBe(false);
    });

    it('rejects a figure with no svg', () => {
      const figure = validFigure() as Record<string, unknown>;
      delete figure.svg;
      const result = validateBlocks([figure]);
      expect(result.valid).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// validateBadgeCriteria — THE CLOSED VOCABULARY of design §9.3.
//
// `badges.criteria` is a jsonb column, so the database cannot express "exactly
// these eight types, each with its own required fields". This function is the
// only thing that can, and BOTH write paths (the importer and the admin CRUD)
// run a value through it. A criteria object that slipped past it would produce
// a badge whose criterion no evaluator in progression/criteria.ts understands
// — a badge nobody can ever earn, and nothing would ever report that.
//
// It also owns an error-quality promise that is easy to regress by
// "simplifying" it into a single `oneOf` compile: validating against all eight
// branches at once produces 23 ajv errors, none of which says the useful
// thing. The last two tests below are what would fail if someone did that.
// ---------------------------------------------------------------------------
describe('validateBadgeCriteria', () => {
  it('accepts a well-formed criterion of a known type', () => {
    expect(validateBadgeCriteria({ type: 'streak_days', days: 7 })).toEqual({ valid: true, errors: [] });
    expect(validateBadgeCriteria({ type: 'course_completed', course: 'code-review' })).toEqual({
      valid: true,
      errors: [],
    });
  });

  it('refuses anything that is not a criteria OBJECT, including an array', () => {
    // An array is the one that matters: `typeof [] === 'object'`, so a check
    // written the obvious way would let a list of criteria through as if it
    // were one criterion, and then read `.type` off it as undefined.
    for (const notAnObject of [null, 'streak_days', 7, [{ type: 'streak_days', days: 7 }]]) {
      const result = validateBadgeCriteria(notAnObject);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual([{ path: '/', message: 'must be a criteria object' }]);
    }
  });

  it('refuses a criteria object whose `type` is missing or is not a string, naming /type', () => {
    for (const badType of [undefined, 7, null, ['streak_days']]) {
      const result = validateBadgeCriteria({ type: badType, days: 7 });
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual([{ path: '/type', message: 'is required and must be a string' }]);
    }
  });

  it('refuses an unknown type with ONE error that lists the whole allowed vocabulary', () => {
    // design §9.3: "adding a ninth type is a deliberate platform change", so an
    // unrecognised type is never a near-miss worth guessing at — the caller
    // gets the closed list instead.
    const result = validateBadgeCriteria({ type: 'lessons_read', count: 3 });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.path).toBe('/type');
    for (const type of BADGE_CRITERION_TYPES) {
      expect(result.errors[0]!.message).toContain(type);
    }
  });

  it('reports a misspelled field against the criterion’s OWN branch, not against all eight', () => {
    // The regression this guards: validating {type: "streak_days", dayz: 7}
    // against the whole eight-branch oneOf yields 23 errors — one set per
    // branch that failed, plus "must match exactly one schema in oneOf" — and
    // buries the two that are actually about streak_days. Dispatching on
    // `type` first is what keeps the count at two.
    const result = validateBadgeCriteria({ type: 'streak_days', dayz: 7 });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      { path: '/', message: "must have required property 'days'" },
      { path: '/', message: 'must NOT have additional properties' },
    ]);
    // Nothing about the seven types the author did not ask for, and no
    // "must match exactly one schema in oneOf" to read past.
    expect(JSON.stringify(result.errors)).not.toContain('perfect_quiz');
    expect(JSON.stringify(result.errors)).not.toContain('oneOf');
  });

  it('refuses a known type that is missing its own required field', () => {
    const result = validateBadgeCriteria({ type: 'track_score', track: 'cx' });
    expect(result.valid).toBe(false);
    expect(JSON.stringify(result.errors)).toContain('min');
  });

  it('exposes the eight type names read off the schema, never a second hand-kept list', () => {
    // If this ever disagrees with schemas/badge.schema.json, the message above
    // is lying to authors about what they may write.
    expect(BADGE_CRITERION_TYPES).toContain('streak_days');
    expect(BADGE_CRITERION_TYPES).toHaveLength(8);
  });
});
