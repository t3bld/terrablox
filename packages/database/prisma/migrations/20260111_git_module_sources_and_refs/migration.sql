-- Applied to Supabase via MCP migration `git_module_sources_and_refs`
--
-- Creates `terraform_module_sources` and adds `source_id` + constraints/indexes to `terraform_modules`.

create table if not exists public.terraform_module_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  name text not null,
  description text,
  tags text[] not null default array[]::text[],
  git_repo text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists terraform_module_sources_user_id_idx
  on public.terraform_module_sources(user_id);

alter table public.terraform_modules
  add column if not exists source_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'terraform_modules_source_id_fkey'
  ) then
    alter table public.terraform_modules
      add constraint terraform_modules_source_id_fkey
      foreign key (source_id)
      references public.terraform_module_sources(id)
      on delete cascade;
  end if;
end $$;

create index if not exists terraform_modules_source_id_idx
  on public.terraform_modules(source_id);

create unique index if not exists terraform_modules_source_ref_path_uniq
  on public.terraform_modules(source_id, version, terraform_root_folder);
