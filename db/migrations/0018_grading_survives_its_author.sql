-- Account deletion, part 1: a student's graded work must outlive the grader.
--
-- ---------------------------------------------------------------------------
-- THE PROBLEM
--
-- `annotations.author_id` and `rubric_scores.scored_by` were both `not null`
-- with `on delete cascade`. Those tables hold TEACHER output attached to
-- STUDENT work: the inline feedback on a submission (Phase 8) and the rubric
-- points awarded to it (Phase 12).
--
-- So deleting a teacher's account did not just remove the teacher — it
-- silently removed every grade and every piece of feedback they had ever left
-- on other people's submissions. A student who had been graded, and could see
-- their score, would find the score gone because someone else closed their
-- account. That is other people's data disappearing as a side effect of my
-- erasure, which is precisely what "deletion removes personal data while
-- preserving referential integrity" (plan) exists to rule out.
--
-- It had never bitten because account deletion did not exist — and it could
-- not exist, because of the append-only cascade that 0017 fixed.
--
-- ---------------------------------------------------------------------------
-- THE FIX
--
-- Follow `audit_log.actor_id` (0005): the record outlives the account, and the
-- identity becomes null rather than taking the record with it. A grade is a
-- fact about a submission, not a possession of the person who entered it.
--
-- Nullable + `on delete set null`, so:
--   * a teacher deleting their account leaves every grade and annotation
--     intact, now unattributed;
--   * a STUDENT deleting theirs still removes the whole submission (via
--     `exercise_submissions.user_id`'s cascade), and the annotations and
--     scores hanging off it go with it — through the submission, which is
--     their own data, not through the author.
--
-- Readers must therefore treat a null author/scorer as "someone who has since
-- left", not as a bug. `api/src/routes/submissions.ts` and the grading UI
-- already render an author name from a join; a null joins to no row and shows
-- nothing, which is the correct outcome and not a crash.
-- ---------------------------------------------------------------------------

alter table annotations alter column author_id drop not null;

alter table annotations drop constraint if exists annotations_author_id_fkey;
alter table annotations
  add constraint annotations_author_id_fkey
  foreign key (author_id) references users (id) on delete set null;

alter table rubric_scores alter column scored_by drop not null;

alter table rubric_scores drop constraint if exists rubric_scores_scored_by_fkey;
alter table rubric_scores
  add constraint rubric_scores_scored_by_fkey
  foreign key (scored_by) references users (id) on delete set null;
