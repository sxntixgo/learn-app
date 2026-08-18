import { describe, it, expect } from 'vitest';
import { computeDegreeProgress, degreeSatisfied } from './degrees.ts';
import type { DegreeDefinition } from './degrees.ts';

const DEGREE: DegreeDefinition = {
  slug: 'secure-code-review',
  title: 'Secure Code Review',
  description: null,
  requiredSlugs: ['code-review', 'go-security'],
  electivesChoose: 2,
  electivesFrom: ['networking', 'python-advanced', 'llm-security'],
};

const IMPORTED = new Map([
  ['code-review', 'Code Review'],
  ['go-security', 'Go Security'],
  ['networking', 'Networking'],
  ['python-advanced', 'Python, Advanced'],
  ['llm-security', 'LLM Security'],
]);

describe('degreeSatisfied', () => {
  it('needs every required course plus `electives.choose` of the electives', () => {
    expect(degreeSatisfied(DEGREE, new Set(['code-review', 'go-security', 'networking']))).toBe(false);
    expect(degreeSatisfied(DEGREE, new Set(['code-review', 'networking', 'python-advanced']))).toBe(false);
    expect(
      degreeSatisfied(DEGREE, new Set(['code-review', 'go-security', 'networking', 'python-advanced'])),
    ).toBe(true);
  });

  it('does not let one course fill both a requirement and an elective slot', () => {
    const overlapping: DegreeDefinition = {
      ...DEGREE,
      requiredSlugs: ['code-review'],
      electivesChoose: 1,
      electivesFrom: ['code-review', 'networking'],
    };
    expect(degreeSatisfied(overlapping, new Set(['code-review']))).toBe(false);
    expect(degreeSatisfied(overlapping, new Set(['code-review', 'networking']))).toBe(true);
  });

  it('is never satisfied by a degree that names nothing', () => {
    // Same reasoning as course_completed on an empty course: "all zero of
    // them are done" would award a degree to every learner on this
    // instance's next progress write, and awards are never revoked.
    const empty: DegreeDefinition = { ...DEGREE, requiredSlugs: [], electivesChoose: 0, electivesFrom: [] };
    expect(degreeSatisfied(empty, new Set(['code-review']))).toBe(false);
  });
});

describe('computeDegreeProgress', () => {
  it('reports each named course, whether imported and whether complete', () => {
    const view = computeDegreeProgress(DEGREE, {
      importedCourses: IMPORTED,
      completedCourses: new Set(['code-review', 'networking']),
      awardedAt: null,
    });

    expect(view.required).toEqual([
      { slug: 'code-review', title: 'Code Review', imported: true, completed: true },
      { slug: 'go-security', title: 'Go Security', imported: true, completed: false },
    ]);
    expect(view.electives?.choose).toBe(2);
    expect(view.electives?.completed).toBe(1);
    expect(view.earned).toBe(false);
    expect(view.awardedAt).toBeNull();
  });

  it('counts required plus the CHOSEN number of electives toward percent', () => {
    // 2 required + 2 chosen electives = 4 slots. One required and one
    // elective done = 50 %.
    const view = computeDegreeProgress(DEGREE, {
      importedCourses: IMPORTED,
      completedCourses: new Set(['code-review', 'networking']),
      awardedAt: null,
    });
    expect(view.percent).toBe(50);
  });

  it('does not let a third elective push percent past 100', () => {
    const view = computeDegreeProgress(DEGREE, {
      importedCourses: IMPORTED,
      completedCourses: new Set([
        'code-review',
        'go-security',
        'networking',
        'python-advanced',
        'llm-security',
      ]),
      awardedAt: null,
    });
    expect(view.percent).toBe(100);
  });

  it('surfaces a degree naming an unimported course as unsatisfiable rather than failing', () => {
    // Design §6.1/§8: curriculum spans repos, so a cross-repo reference
    // never fails an import — it shows up here instead.
    const view = computeDegreeProgress(DEGREE, {
      importedCourses: new Map([['code-review', 'Code Review']]),
      completedCourses: new Set(['code-review']),
      awardedAt: null,
    });

    expect(view.satisfiable).toBe(false);
    expect(view.missingCourses).toEqual(['go-security', 'networking', 'python-advanced', 'llm-security']);
    expect(view.required[1]).toEqual({ slug: 'go-security', title: null, imported: false, completed: false });
  });

  it('is satisfiable when every named course is imported', () => {
    const view = computeDegreeProgress(DEGREE, {
      importedCourses: IMPORTED,
      completedCourses: new Set(),
      awardedAt: null,
    });
    expect(view.satisfiable).toBe(true);
    expect(view.missingCourses).toEqual([]);
    expect(view.percent).toBe(0);
  });

  it('reports null electives for a degree that declares none', () => {
    const view = computeDegreeProgress(
      { ...DEGREE, electivesChoose: 0, electivesFrom: [] },
      { importedCourses: IMPORTED, completedCourses: new Set(['code-review', 'go-security']), awardedAt: null },
    );
    expect(view.electives).toBeNull();
    expect(view.percent).toBe(100);
  });

  it('reports an award as earned regardless of what the requirements now say', () => {
    // Design §9.3's "never revoked", applied to degrees: an award is a fact
    // about a moment, so re-scoping the degree afterwards moves `percent`
    // but must never move `earned`.
    const awardedAt = new Date('2026-08-01T00:00:00Z');
    const view = computeDegreeProgress(DEGREE, {
      importedCourses: IMPORTED,
      completedCourses: new Set(),
      awardedAt,
    });
    expect(view.earned).toBe(true);
    expect(view.awardedAt).toBe(awardedAt);
    expect(view.percent).toBe(0);
  });
});
