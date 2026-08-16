-- gen_random_uuid() ships in Postgres core (no pgcrypto needed) since PG13.
create table lessons (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique,
  title        text not null,
  blocks       jsonb not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
