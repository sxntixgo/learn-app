// =============================================================================
// track_score: POOLING THE TWO SOURCES OF MEASURED RESULT (design §9.1, §9.3).
//
// Design §9.1: "All scores are authoritative. Quizzes are machine-scored;
// exercises are teacher-scored. There is no self-reported data in the system,
// so `track_score` badge criteria and per-track reporting draw on measured
// results only. QUIZ QUESTIONS CARRY A TRACK; RUBRIC CRITERIA CARRY A TRACK."
//
// Two tables record those results, in two different units:
//
//   quiz_attempts.track_scores  jsonb  track -> {correct, total}
//   rubric_scores               rows   (criterion, points, max, track)
//
// A badge reading only one of them is quietly wrong — a `track_score` badge on
// a course whose track is assessed by exercises would never fire if it read
// quiz_attempts alone, and vice versa. So this module pools both.
//
// HOW THEY COMBINE — stated, as db/migrations/0012_rubric_scores.sql's header
// asks and as this phase's task demands:
//
//   earned   = Σ quiz correct  +  Σ rubric points
//   possible = Σ quiz total    +  Σ rubric max
//   score    = 100 × earned / possible
//
// SUM OF POINTS OVER SUM OF MAXIMA, across both sources, treating a quiz
// question as a criterion worth exactly 1 point. This is the reading migration
// 0012 already wrote down, and it has the property that matters: a track
// assessed by ten quiz questions and one 10-point rubric criterion weights the
// two halves equally, because "possible" is what does the weighting rather
// than an arbitrary 50/50 split between sources. Averaging two percentages
// instead would let a single one-question quiz outweigh an entire graded
// exercise.
//
// TWO SCOPING RULES, both of which change the number and so are stated rather
// than left to the reader of a SQL file:
//
//   1. ONE QUIZ ATTEMPT PER LESSON — THE LATEST. Design §9.1 permits retakes.
//      Summing every attempt would let a student raise a pooled track score
//      simply by re-sitting a quiz they already ace: each perfect retake adds
//      (n correct, n total) and drags the ratio up toward 100 %. The latest
//      attempt is the student's current standing on that lesson, which is
//      also how lesson_progress records exactly one state per lesson. The
//      SELECT DISTINCT ON in facts.ts is where this is implemented.
//   2. ONLY RETURNED SUBMISSIONS COUNT. A rubric_scores row exists only once
//      a teacher has graded, and grading and returning happen in the same
//      transaction, so this is belt-and-braces — but it is what keeps a
//      half-finished grading pass from moving a student's badge.
//
// Both halves exclude archived lessons and archived modules, matching every
// other progress query in the codebase.
// =============================================================================

/** One (course, track) bucket of measured result, from one source. */
export interface TrackTally {
  courseSlug: string;
  track: string;
  earned: number;
  possible: number;
}

/** A pooled bucket, keyed by course + track. */
export interface PooledTrack {
  courseSlug: string;
  track: string;
  earned: number;
  possible: number;
}

function key(courseSlug: string, track: string): string {
  return `${courseSlug}\n${track}`;
}

/**
 * Pools quiz and rubric tallies into one bucket per (course, track).
 *
 * Takes both lists rather than a single pre-merged one so the caller cannot
 * accidentally pass the same source twice, and so a reader can see at the
 * call site that both tables were consulted.
 */
export function poolTrackTallies(
  quizTallies: readonly TrackTally[],
  rubricTallies: readonly TrackTally[],
): Map<string, PooledTrack> {
  const pooled = new Map<string, PooledTrack>();

  for (const tally of [...quizTallies, ...rubricTallies]) {
    const k = key(tally.courseSlug, tally.track);
    const bucket = pooled.get(k) ?? { courseSlug: tally.courseSlug, track: tally.track, earned: 0, possible: 0 };
    bucket.earned += tally.earned;
    bucket.possible += tally.possible;
    pooled.set(k, bucket);
  }

  return pooled;
}

export interface TrackScore {
  earned: number;
  possible: number;
  /** 0-100, or null when nothing has been measured on this track yet. */
  percent: number | null;
}

/**
 * The pooled percentage for `track`, optionally narrowed to one course.
 *
 * WITHOUT a `course`, buckets from every course declaring a track of that key
 * are pooled together: track keys are course-local (`tracks.key` is unique per
 * course, not globally), so `{type: track_score, track: cx, min: 90}` means
 * "90 % across everything tagged cx anywhere", and `{..., course: code-review}`
 * means "90 % on code-review's cx". Both readings are legitimate and the
 * schema offers `course` precisely to choose between them.
 *
 * `percent` is null — NOT zero — when nothing has been measured. Zero would
 * be a real score of 0 %, and the two must not be confused: a `min: 0` badge
 * must not fire for a student who has never answered a question. Callers
 * treat null as unsatisfied.
 */
export function trackScoreOf(
  pooled: ReadonlyMap<string, PooledTrack>,
  track: string,
  course?: string,
): TrackScore {
  let earned = 0;
  let possible = 0;

  for (const bucket of pooled.values()) {
    if (bucket.track !== track) continue;
    if (course !== undefined && bucket.courseSlug !== course) continue;
    earned += bucket.earned;
    possible += bucket.possible;
  }

  return { earned, possible, percent: possible === 0 ? null : (earned / possible) * 100 };
}
