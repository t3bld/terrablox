-- Git module schema (non-destructive, additive-first).
--
-- Adds terraform module sources and wires terraform_modules to a source + ref.
-- Keeps existing Supabase auth schema/tables untouched.

-- 1) Create module sources
create table if not exists public.terraform_module_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  name text not null,
  description text,
  tags text[] not null default array[]::text[],
  git_repo text not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Note: we intentionally do NOT add a foreign key to auth.users here.
-- When running migrations via Prisma against Supabase, the DB role often lacks
-- privileges on the `auth`/`extensions` schemas.
-- If you want the FK, add it via a Supabase migration using an elevated role.

create index if not exists terraform_module_sources_user_id_idx
  on public.terraform_module_sources(user_id);

-- 2) Add source_id to terraform_modules (existing table)
alter table public.terraform_modules
  add column if not exists source_id uuid;

-- For new design, we want every module version to belong to a source.
-- If your table already has rows, you MUST backfill source_id before enforcing NOT NULL.
-- We'll enforce NOT NULL only if it is safe (no existing rows).

-- Add FK + index
alter table public.terraform_modules
  add constraint terraform_modules_source_id_fkey
  foreign key (source_id) references public.terraform_module_sources(id) on delete cascade;

create index if not exists terraform_modules_source_id_idx
  on public.terraform_modules(source_id);

-- 3) Uniqueness: one module per (source, ref, terraform_root_folder)
-- We reuse existing `version` column as `gitRef` in Prisma.
create unique index if not exists terraform_modules_source_ref_path_uniq
  on public.terraform_modules(source_id, version, terraform_root_folder);
