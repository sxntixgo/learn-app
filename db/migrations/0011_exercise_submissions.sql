-- Phase 8: exercise_submissions + annotations (design §7, §9.4).
--
-- THE ONE RULE THIS MIGRATION EXISTS TO ENFORCE (design §9.4, verbatim):
--
--   "Submissions snapshot the block content as presented, and annotations
--    anchor to the snapshot — never to the live lesson. Otherwise an
--    annotation on 'line 14' silently corrupts the moment that lesson is
--    edited, and every past submission rots."
--
-- Lessons are DERIVED state: `api/src/content/import.ts` upserts them on
-- their natural key on every sync, rewriting `blocks` in place. A submission
-- is USER history and cannot be recovered (design §7's organizing
-- principle). So a submission carries its OWN copy of the block array, and
-- an annotation's line numbers are read against that copy and nothing else.
--
-- Three structural devices make that true rather than merely conventional.
-- Each of them is a thing the database refuses, not a thing the application
-- remembers:
--
--   1. `annotations` HAS NO `lesson_id`. There is no column through which an
--      anchor could reach the live lesson, so "anchor to the snapshot" is
--      not a discipline the route has to keep — it is the only path that
--      exists. Reaching content from an annotation is
--      annotations -> exercise_submissions.snapshot, full stop.
--
--   2. THE SNAPSHOT IS FROZEN AT INSERT. The trigger below rejects any
--      UPDATE that changes `snapshot` or `snapshot_hash`. Same shape of
--      guarantee as 0004's append-only `activity_events` trigger, and for
--      the same reason: a rule that lives only in a route is one careless
--      `update ... set snapshot = ...` away from silently re-anchoring every
--      annotation on the row.
--
--   3. AN ANNOTATION NAMES THE SNAPSHOT IT WAS WRITTEN AGAINST. Annotations
--      carry `snapshot_hash` and reference `exercise_submissions
--      (id, snapshot_hash)` as a composite foreign key. The column is
--      redundant with device 2 by design: if device 2 were ever dropped, a
--      snapshot rewrite would now fail with a foreign-key violation instead
--      of succeeding quietly. The failure mode this schema is built against
--      is silence, so the redundancy is the point.
--
-- ONE ROW PER (user, lesson) — WHY NOT A NEW ROW PER RETAKE
-- ---------------------------------------------------------
-- `unique (user_id, lesson_id)`: an exercise has one current submission,
-- reused, and there is no retake row. The reasons, in order of weight:
--
--   - Design §7 draws `exercise_submissions ─┬─ annotations ─└─ rubric_scores`
--     and §9.4 describes grading as "an additive layer attaching a score and
--     feedback afterward" to THE submission. A second row would fork that
--     layer: which submission does the teacher's reply hang off, and which
--     one is the score of record?
--   - §9.1 explicitly permits quiz retakes ("re-attempting is allowed") and
--     says nothing of the kind for exercises, whose §9.4 flow runs
--     submit -> grading queue -> returned, once.
--   - The grading queue (Phase 9) is "submissions awaiting review". Multiple
--     live rows per student per exercise make that a de-duplication problem
--     before it is a feature.
--   - It is the reversible choice. Adding `attempt integer not null
--     default 1` and widening this constraint later is additive; merging two
--     histories of teacher feedback back into one is not.
--
-- What reuse must NOT mean is a returned submission being quietly rewritten
-- by the next draft save. That refusal is deliberately NOT left to the
-- route: the status/timestamp CHECKs below make the illegal states
-- unrepresentable, and device 2 makes the snapshot itself unwritable. The
-- route (api/src/routes/submissions.ts) 409s a draft write against a
-- `submitted` or `returned` row on top of that.

create table if not exists exercise_submissions (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users (id) on delete cascade,
  lesson_id      uuid not null references lessons (id) on delete cascade,

  -- draft     — being written, only the student has seen it
  -- submitted — handed in. Completes the lesson (design §9.1: "exercises
  --             complete on SUBMIT, not on teacher return" — a private
  --             course of one has no grader and must still finish)
  -- returned  — graded and handed back (Phase 9 sets this)
  status         text not null default 'draft' check (status in ('draft', 'submitted', 'returned')),

  -- The block array EXACTLY as it was presented to the student, in the
  -- API's own presentation form (api/src/content/present.ts) — not the raw
  -- lesson row, because what the student saw is what a teacher grading a
  -- month later must see.
  snapshot       jsonb not null,
  -- sha256 of the canonical JSON of `snapshot`. Two jobs: it is what proves
  -- a snapshot is byte-identical to the one submitted, and it is the
  -- composite-FK partner that ties an annotation to one specific snapshot.
  snapshot_hash  text not null,

  submitted_at   timestamptz,
  returned_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  unique (user_id, lesson_id),

  -- Device 3 needs a unique key on exactly these two columns to point at.
  unique (id, snapshot_hash),

  -- The status and its timestamps cannot disagree. A 'submitted' row with
  -- no submitted_at would make the activity feed and the grading queue tell
  -- different stories about the same submission.
  constraint exercise_submissions_draft_has_no_timestamps
    check (status <> 'draft' or (submitted_at is null and returned_at is null)),
  constraint exercise_submissions_submitted_has_submitted_at
    check (status <> 'submitted' or (submitted_at is not null and returned_at is null)),
  constraint exercise_submissions_returned_has_both
    check (status <> 'returned' or (submitted_at is not null and returned_at is not null))
);

-- "This student's submission for this lesson" is the only lookup the route
-- makes; the unique constraint above already indexes it. This one serves
-- Phase 9's grading queue ("submissions awaiting review, oldest first").
create index if not exists idx_exercise_submissions_status
  on exercise_submissions (status, submitted_at);

-- Device 2. Anything about a submission may change — its status, its
-- timestamps — except the thing every annotation's line numbers are read
-- against.
create or replace function exercise_submissions_freeze_snapshot() returns trigger as $$
begin
  if new.snapshot is distinct from old.snapshot or new.snapshot_hash is distinct from old.snapshot_hash then
    raise exception
      'exercise_submissions.snapshot is frozen at insert (design §9.4): every annotation on submission % anchors to it',
      old.id;
  end if;
  return new;
end;
$$ language plpgsql;

create or replace trigger exercise_submissions_snapshot_frozen
  before update on exercise_submissions
  for each row execute function exercise_submissions_freeze_snapshot();

-- annotations
--
-- Design §9.4: "in an exercise it accepts student annotations against a line
-- or line range", and "a parent_id lets a teacher reply to a specific
-- student comment, while a top-level teacher annotation flags a line the
-- student missed entirely".
--
-- `parent_id` lands now and is unused in Phase 8 — threading is Phase 9.
-- The column is here rather than added later because a reply is an
-- annotation, and discovering that after annotations exist means a
-- migration over live user data.
create table if not exists annotations (
  id             uuid primary key default gen_random_uuid(),

  submission_id  uuid not null references exercise_submissions (id) on delete cascade,
  -- Device 3: not "which submission" (submission_id already says that) but
  -- "which SNAPSHOT OF that submission" — see the header.
  snapshot_hash  text not null,

  -- Who wrote it: the student in Phase 8, a teacher grading in Phase 9.
  author_id      uuid not null references users (id) on delete cascade,
  parent_id      uuid,

  -- THE ANCHOR, and it is an anchor into `snapshot`, not into any lesson:
  -- `block_index` indexes the snapshot's own block array, and the lines are
  -- 1-indexed and inclusive over that block's `source`, matching
  -- web/src/lib/annotations.ts's LineRange exactly.
  block_index    integer not null check (block_index >= 0),
  start_line     integer not null check (start_line >= 1),
  end_line       integer not null check (end_line >= 1),

  body           text not null check (btrim(body) <> ''),
  -- Optional track id (design §6.1), matching a track's key in course.yaml.
  track          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint annotations_range_not_inverted check (end_line >= start_line),

  foreign key (submission_id, snapshot_hash)
    references exercise_submissions (id, snapshot_hash) on delete cascade,

  -- A reply belongs to the same submission as the comment it answers —
  -- structurally, not by convention, so Phase 9 cannot thread an annotation
  -- under someone else's submission by passing the wrong id.
  unique (id, submission_id),
  foreign key (parent_id, submission_id)
    references annotations (id, submission_id) on delete cascade
);

-- Reading order for a submission (design §9.4's cards, filed by anchor).
create index if not exists idx_annotations_submission
  on annotations (submission_id, block_index, start_line, end_line);

-- Phase 9's "replies to this annotation".
create index if not exists idx_annotations_parent on annotations (parent_id);
