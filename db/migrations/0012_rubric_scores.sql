-- Phase 9: rubric_scores (design §7, §9.4, Task C).
--
-- "exercise_submissions ─┬─ annotations ─└─ rubric_scores" (design §7's own
-- diagram) — the third leg of grading, alongside the annotations migration
-- 0011 already laid down. A user table, not a content table (design §7:
-- "content tables are derived state; user tables are source of truth.
-- Nothing under `users` can be recovered.") — a rubric SCORE is exactly as
-- irrecoverable as a quiz_attempts row, so it gets the same treatment.
--
-- ONE ROW PER (submission, criterion) — WHY, AND WHY "criterion" IS A NAME
-- --------------------------------------------------------------------------
-- The task instructions ask for "criterion (name or index — pick and
-- justify)". This picks NAME, for two reasons:
--
--   1. A submission's rubric criteria come from `exercise_submissions.
--      snapshot` (design §9.4: "submissions snapshot the block content as
--      presented ... never the live lesson"), which is frozen at first save
--      and never rewritten (0011's trigger). So the criteria list for a
--      given submission cannot change out from under a score no matter
--      which identifier is used — index would be exactly as stable as name
--      here, because there is nothing left for either to drift against.
--      Stability is not the deciding factor.
--   2. NAME is what makes a `rubric_scores` row self-describing without a
--      join back into the snapshot's jsonb. "cx track, 4/5 on 'Spotted the
--      shallow module'" is readable straight off this table — in an export,
--      in a debugging session, in the eventual track_score badge query
--      (Phase 11) — where "criterion 0" is not. Index would save nothing
--      (there is no wider-than-a-uuid identity problem it solves) and cost
--      this readability every time the row is read outside the route that
--      wrote it.
--
-- `unique (submission_id, criterion)` follows from "one row per criterion":
-- a teacher re-scoring a criterion UPDATEs that row (upsert via ON CONFLICT
-- in the grade route) rather than appending a second opinion next to the
-- first — see the re-grading note below.
--
-- RE-GRADING (Task C's explicit decision point)
-- --------------------------------------------------------------------------
-- ALLOWED, deliberately: a teacher who mis-scored a criterion or missed one
-- entirely must be able to fix it without a support-ticket-shaped escape
-- hatch, and blocking re-grades outright would make every grading mistake
-- permanent. What is NOT allowed is the thing the task actually warns
-- against — the student silently LOSING feedback they have already read:
--
--   - Every grade call requires ALL of the exercise's declared criteria
--     (api/src/routes/submissions.ts validates this against the frozen
--     snapshot's rubric block before writing anything), so a score is never
--     partially overwritten into an inconsistent state.
--   - A grade call never deletes an annotation. Annotations only
--     accumulate — a re-grade adds more, it does not touch what is already
--     there (enforced by the route only ever INSERTing into `annotations`,
--     never UPDATE/DELETE on someone else's row).
--   - `exercise_submissions.returned_at` is stamped once (first grade call)
--     and never rewritten on a later one, and exactly one `exercise_returned`
--     activity event is ever emitted for a submission (design §10's closed
--     event vocabulary has no "regraded" type to emit a second one as, and
--     inventing one is a platform-vocabulary change this task does not ask
--     for) — so a re-grade updates what the student sees without pretending
--     a second "your feedback arrived" notification is warranted.
--
-- `updated_at` is NOT in the task's literal column list (submission_id,
-- criterion, points, max, track, scored_by, created_at) but is added
-- anyway: without it, a re-graded row would keep lying about when it was
-- last touched, which is exactly the kind of silent drift this schema is
-- built against elsewhere (see lessons.updated_at, exercise_submissions.
-- updated_at). `created_at` still records the FIRST score, `updated_at` the
-- most recent — the same split quiz_attempts does not need (it is
-- append-only) but exercise_submissions already does.
create table if not exists rubric_scores (
  id             uuid primary key default gen_random_uuid(),

  submission_id  uuid not null references exercise_submissions (id) on delete cascade,

  -- The criterion's `name` from the rubric block in THIS submission's frozen
  -- snapshot — see the header for why name, not index.
  criterion      text not null check (btrim(criterion) <> ''),

  points         numeric(6, 2) not null check (points >= 0),
  -- Denormalized from the rubric block rather than re-read from the
  -- snapshot on every query, matching quiz_attempts.score/answers storing
  -- the outcome rather than forcing every reader back through the block —
  -- and it is what makes `points <= max` checkable as a database constraint.
  max            numeric(6, 2) not null check (max > 0),
  constraint rubric_scores_points_within_max check (points <= max),

  -- Optional track id (design §6.1), matching the criterion's own `track`
  -- and a track's key in course.yaml — nullable because a criterion is not
  -- required to declare one (schemas/blocks.schema.json's rubricCriterion).
  track          text,

  -- Who scored it. Not "who returned the submission" (that is the LATEST
  -- scorer, generally, but co-grading is not a feature this table forbids)
  -- — the scorer of THIS criterion, specifically.
  scored_by      uuid not null references users (id) on delete cascade,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  unique (submission_id, criterion)
);

-- "This submission's scores" (the grade route's read-modify-write and the
-- reader rendering a returned submission) is the primary lookup; the unique
-- constraint above already indexes it. This one serves per-track roll-up
-- (design §9.1/§9.3's track_score badge criterion, Phase 11) — "every scored
-- criterion on this track, across submissions" — the same query shape
-- quiz_attempts.track_scores exists to make cheap, covered below.
create index if not exists idx_rubric_scores_track on rubric_scores (track) where track is not null;

-- ---------------------------------------------------------------------------
-- HOW RUBRIC SCORES AND QUIZ TRACK SCORES COMBINE (Task C: "say how").
-- ---------------------------------------------------------------------------
--
-- quiz_attempts.track_scores (migration 0010) is a per-attempt jsonb map of
-- track -> {correct, total}, where every question is worth exactly 1 point.
-- rubric_scores is normalized, one row per (submission, criterion), where a
-- criterion is worth up to `max` points. These are not the same unit until
-- you notice that "correct" IS "points earned out of a 1-point max" — so a
-- track's combined score is simply:
--
--   earned = sum(quiz_attempts.track_scores[track].correct, over the
--                attempts that count) + sum(rubric_scores.points where
--                track = track and submission is returned)
--   possible = sum(quiz_attempts.track_scores[track].total, ditto)
--            + sum(rubric_scores.max, ditto)
--   track_score = earned / possible
--
-- No jsonb roll-up column is added to rubric_scores to pre-aggregate this,
-- unlike quiz_attempts.track_scores: rubric_scores is ALREADY normalized
-- with `track` on every row, so "every scored criterion on this track" is
-- the GROUP BY the index above exists to serve, not a reconstruction from a
-- wider blob the way quiz_attempts.answers would be. Phase 11's track_score
-- badge criterion is the first consumer of this and is not built here — this
-- comment is the contract it implements against, per Task C's instruction to
-- say how the two sources combine rather than build the criterion itself.
