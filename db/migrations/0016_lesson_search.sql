-- Phase 16: full-text search over lessons (design §16, plan Phase 16).
--
-- ---------------------------------------------------------------------------
-- 1. lesson_prose_text — the searchable text of a lesson's blocks
--
-- `lessons.blocks` is a typed block array (CLAUDE.md rule 5), and a prose
-- block holds HTML, not plain text (`{ type: 'prose', html }` in
-- api/src/content/parse.ts). Indexing that HTML directly would put every tag
-- and attribute name into the lexeme set, so `div` would be a search term and
-- a lesson mentioning "class" would match markup rather than prose. Tags are
-- stripped to spaces — to spaces and not to nothing, so `<p>one</p><p>two</p>`
-- yields two words rather than the single word `onetwo`.
--
-- Only `prose` blocks are indexed. Code blocks are deliberately excluded: a
-- keyword search over source would match language keywords in every lesson
-- that happens to contain a loop, which is noise, not recall. Quizzes,
-- exercises and figures are likewise skipped — none of them is what someone
-- means by "find the lesson about X".
--
-- IMMUTABLE is what lets this be used in the generated column below, and it
-- is honest here: the result depends only on the argument. PARALLEL SAFE
-- follows from the same property.
-- ---------------------------------------------------------------------------
create or replace function lesson_prose_text(blocks jsonb) returns text
  language sql
  immutable
  parallel safe
as $$
  select coalesce(
    string_agg(regexp_replace(block->>'html', '<[^>]*>', ' ', 'g'), ' '),
    ''
  )
  from jsonb_array_elements(coalesce(blocks, '[]'::jsonb)) as block
  where block->>'type' = 'prose'
    and block->>'html' is not null
$$;

-- ---------------------------------------------------------------------------
-- 2. lessons.search_vector — GENERATED, not maintained by the importer
--
-- The plan says "a tsvector column maintained on import". A stored generated
-- column is the same thing with the drift removed: Postgres recomputes it on
-- every insert and update of `blocks`/`title`, so there is no path — a manual
-- `psql` fix, a future importer, a restored backup, a migration that
-- backfills content — that can leave a lesson indexed under its old text.
-- "Maintained on import" is only true for as long as import is the sole
-- writer, and this table already has other writers.
--
-- Title is weighted A and prose B: a lesson *called* "Recursion" should
-- outrank one that mentions recursion in passing.
--
-- 'english' is written as a literal rather than left to `default_text_search_
-- config`, because a generated column's expression must be immutable and
-- `to_tsvector(text)` is only stable — it reads that setting. Writing the
-- config out also means the index cannot silently change meaning if the
-- database's default is ever altered.
-- ---------------------------------------------------------------------------
alter table lessons
  add column if not exists search_vector tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', lesson_prose_text(blocks)), 'B')
  ) stored;

-- GIN over the vector: the standard index for @@ queries, and the reason this
-- is a stored column rather than an expression evaluated per row at query
-- time.
create index if not exists idx_lessons_search_vector on lessons using gin (search_vector);

-- Search always filters to non-archived lessons in courses the actor may see
-- (api/src/search/query.ts), so the visibility and archival columns it joins
-- on carry their own index. `courses.visibility` is already indexed by 0008.
create index if not exists idx_lessons_archived_at on lessons (archived_at);
