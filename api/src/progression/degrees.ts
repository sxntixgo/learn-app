// =============================================================================
// DEGREES (design §9.2, §6.1).
//
//   "Defined in git, in a curriculum repo. Awarded when `required` courses are
//    complete and `electives.choose` is satisfied. Progress toward unearned
//    degrees is visible."
//
// Pure functions over slugs, with no database access, for the same reason
// evaluate.ts is pure: the interesting rules — what "satisfied" means, what an
// unimported course does to a degree — are then testable without a fixture.
//
// THE CROSS-REPO RULE IS THE POINT OF THIS MODULE. Design §6.1: "courses are
// referenced by global slug, so a degree may span repos. A degree whose
// requirements are not all imported shows as UNSATISFIABLE in admin rather
// than appearing broken to students", and design §8 forbids the alternative
// outright — a cross-repo reference never fails an import. So a slug with no
// course behind it is DATA here (`imported: false`, listed in
// `missingCourses`), never an error.
//
// Note what `satisfiable` is NOT: it is not the award gate. Awarding is
// decided by `degreeSatisfied` from completed courses alone, and a course
// that was never imported simply can never be completed — so an unsatisfiable
// degree cannot be awarded by construction, without a single special case.
// `satisfiable` exists to tell an ADMIN why nobody is earning it.
// =============================================================================

/** One degree row, as `degrees` stores it. */
export interface DegreeDefinition {
  slug: string;
  title: string;
  description: string | null;
  /** Course slugs that must ALL be complete. */
  requiredSlugs: readonly string[];
  /** How many of `electivesFrom` are needed. 0 means the degree declares no electives. */
  electivesChoose: number;
  electivesFrom: readonly string[];
}

/** One course a degree names, as a learner sees it. */
export interface DegreeRequirementView {
  slug: string;
  /** The imported course's title, or null when this instance has not imported it. */
  title: string | null;
  imported: boolean;
  completed: boolean;
}

export interface DegreeElectivesView {
  choose: number;
  from: DegreeRequirementView[];
  completed: number;
}

export interface DegreeProgressView {
  slug: string;
  title: string;
  description: string | null;
  earned: boolean;
  awardedAt: Date | null;
  required: DegreeRequirementView[];
  /** Null when the degree declares no electives. */
  electives: DegreeElectivesView | null;
  satisfiable: boolean;
  missingCourses: string[];
  percent: number;
}

export interface DegreeContext {
  /** Every course this instance has imported: slug -> title. */
  importedCourses: ReadonlyMap<string, string>;
  /** The learner's completed course slugs (every live lesson complete). */
  completedCourses: ReadonlySet<string>;
  /** When `user_degrees` holds an award, else null. */
  awardedAt: Date | null;
}

/**
 * The elective slugs that can actually earn elective credit.
 *
 * A slug appearing in both `required` and `electives.from` would otherwise be
 * counted twice — `required: [a], electives: {choose: 1, from: [a, b]}` would
 * be earned by completing `a` alone, which is one course for a two-course
 * degree. Required always wins; the elective slot stays open.
 */
function electiveCandidates(degree: DegreeDefinition): readonly string[] {
  const required = new Set(degree.requiredSlugs);
  return degree.electivesFrom.filter((slug) => !required.has(slug));
}

/** How many slots a degree has in total: required courses plus chosen electives. */
function totalSlots(degree: DegreeDefinition): number {
  return degree.requiredSlugs.length + degree.electivesChoose;
}

/**
 * Whether `completedCourses` earns `degree`.
 *
 * A degree naming NOTHING is never satisfied. "All zero required courses are
 * complete" is true for every learner on the instance, so without this guard
 * a manifest typo would award a degree to everybody on their next progress
 * write — and design §9.3's "never revoked" applies to degrees too, so there
 * would be no way back.
 */
export function degreeSatisfied(degree: DegreeDefinition, completedCourses: ReadonlySet<string>): boolean {
  if (totalSlots(degree) === 0) return false;
  if (!degree.requiredSlugs.every((slug) => completedCourses.has(slug))) return false;

  const electivesDone = electiveCandidates(degree).filter((slug) => completedCourses.has(slug)).length;
  return electivesDone >= degree.electivesChoose;
}

function requirementView(slug: string, ctx: DegreeContext): DegreeRequirementView {
  const title = ctx.importedCourses.get(slug);
  return {
    slug,
    title: title ?? null,
    imported: title !== undefined,
    completed: ctx.completedCourses.has(slug),
  };
}

/**
 * A degree with the learner's progress toward it (design §9.2: "progress
 * toward unearned degrees is visible").
 *
 * `earned` comes from `ctx.awardedAt` and is NEVER recomputed from the
 * requirements — design §9.3. Retuning a degree afterwards moves `percent`;
 * it must not move `earned`, so the two are deliberately independent here and
 * a view with `earned: true, percent: 0` is a legitimate state rather than a
 * contradiction.
 */
export function computeDegreeProgress(degree: DegreeDefinition, ctx: DegreeContext): DegreeProgressView {
  const required = degree.requiredSlugs.map((slug) => requirementView(slug, ctx));
  const electiveViews = degree.electivesFrom.map((slug) => requirementView(slug, ctx));

  const electivesDone = electiveCandidates(degree).filter((slug) => ctx.completedCourses.has(slug)).length;
  const requiredDone = required.filter((r) => r.completed).length;

  const slots = totalSlots(degree);
  const filled = requiredDone + Math.min(electivesDone, degree.electivesChoose);
  const percent = slots === 0 ? 0 : Math.round((Math.min(filled, slots) / slots) * 100);

  const missingCourses = [...required, ...electiveViews].filter((r) => !r.imported).map((r) => r.slug);

  return {
    slug: degree.slug,
    title: degree.title,
    description: degree.description,
    earned: ctx.awardedAt !== null,
    awardedAt: ctx.awardedAt,
    required,
    electives:
      degree.electivesChoose > 0 || degree.electivesFrom.length > 0
        ? { choose: degree.electivesChoose, from: electiveViews, completed: electivesDone }
        : null,
    satisfiable: missingCourses.length === 0,
    missingCourses,
    percent,
  };
}
