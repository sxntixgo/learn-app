-- Phase 7: quiz_attempts (design §7, §9.1).
--
-- "users ─┬─ quiz_attempts ─── lessons" — a user table, not a content table
-- (design §7's organizing principle: "content tables are derived state;
-- user tables are source of truth. Nothing under `users` can be
-- recovered."). Unlike lesson_progress (one row per user+lesson, upserted),
-- an attempt is append-style: a student may retake a quiz, and design §9.1
-- says as much ("Re-attempting is allowed... but completion is recorded
-- once") — so every submission gets its own row, a full history of scores
-- over time, and completion itself lives where it always has, on
-- lesson_progress (migration 0004). This table never marks a lesson
-- complete on its own; the scoring route (api/src/routes/quiz.ts) writes
-- both in one transaction.
--
-- Columns
-- -------
-- `score`        0..1, the fraction of questions answered correctly.
-- `passed`       score >= the block's own `pass` threshold at submission
--                time — stored rather than re-derived, because the
--                THRESHOLD can change on a content re-import and a past
--                attempt's pass/fail must not silently flip retroactively
--                (the same "submissions snapshot what was presented"
--                principle design §9.4 states for exercises).
-- `answers`      Per-question breakdown: which choice was picked, whether
--                it was correct, and that question's track (or null) —
--                design §7 asks for "a per-question breakdown carrying
--                track" and this is it; also what lets the reader show
--                per-question feedback after submission (Task C) and what
--                a re-fetched attempt would use to re-render results.
-- `track_scores` The same information pre-aggregated per track (design
--                §7: "quiz_attempts.track_id make[s] per-track scoring a
--                query rather than a reconstruction" — a single quiz's
--                questions can span more than one track, so this is a
--                jsonb map of track id -> {correct, total} rather than one
--                scalar track_id column, but it exists for exactly the
--                reason that line does: so a future track_score badge
--                criterion (design §9.3, Phase 11) can aggregate straight
--                off this column instead of re-walking `answers` and the
--                lesson's current blocks (which may have changed since).
create table if not exists quiz_attempts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users (id) on delete cascade,
  lesson_id     uuid not null references lessons (id) on delete cascade,
  score         numeric(4, 3) not null check (score >= 0 and score <= 1),
  passed        boolean not null,
  answers       jsonb not null default '[]'::jsonb,
  track_scores  jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

-- "A student's attempts on this quiz, most recent first" (revisit /
-- history) and "did this student ever pass this quiz" (the idempotence
-- check the scoring route runs before writing lesson_progress) are the two
-- lookups this table serves.
create index if not exists idx_quiz_attempts_user_lesson on quiz_attempts (user_id, lesson_id, created_at desc);
