-- Applied to Supabase via MCP migration `clean_git_module_naming`
--
-- Clean up naming for git-based module sources and module versions.
-- Applies requested changes while preserving data via column renames where possible.

begin;

-- ----------------------
-- terraform_modules
-- ----------------------

-- source_url -> url (preserve existing data)
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'terraform_modules'
      and column_name = 'source_url'
  ) then
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public'
        and table_name = 'terraform_modules'
        and column_name = 'url'
    ) then
      alter table public.terraform_modules
        rename column source_url to url;
    else
      -- If both exist for some reason, prefer `url` and drop legacy.
      alter table public.terraform_modules
        drop column if exists source_url;
    end if;
  end if;
end $$;

-- version -> version_tag
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'terraform_modules'
      and column_name = 'version'
  ) then
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public'
        and table_name = 'terraform_modules'
        and column_name = 'version_tag'
    ) then
      alter table public.terraform_modules
        rename column version to version_tag;
    end if;
  end if;
end $$;

-- remove tags
alter table public.terraform_modules
  drop column if exists tags;

-- add submodules_root_folder
alter table public.terraform_modules
  add column if not exists submodules_root_folder text;


-- ----------------------
-- terraform_module_sources
-- ----------------------

-- git_repo -> url (preserve existing data)
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'terraform_module_sources'
      and column_name = 'git_repo'
  ) then
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public'
        and table_name = 'terraform_module_sources'
        and column_name = 'url'
    ) then
      alter table public.terraform_module_sources
        rename column git_repo to url;
    else
      alter table public.terraform_module_sources
        drop column if exists git_repo;
    end if;
  end if;
end $$;

-- add provider
alter table public.terraform_module_sources
  add column if not exists provider text;

-- backfill + constraints for provider
update public.terraform_module_sources
set provider = 'github'
where provider is null;

alter table public.terraform_module_sources
  alter column provider set default 'github';

alter table public.terraform_module_sources
  alter column provider set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'terraform_module_sources_provider_check'
  ) then
    alter table public.terraform_module_sources
      add constraint terraform_module_sources_provider_check
      check (provider in ('github', 'gitlab', 'upload'));
  end if;
end $$;

-- user_id -> auth.users(id)
do $$
begin
  if to_regclass('auth.users') is not null
     and not exists (
       select 1 from pg_constraint
       where conname = 'terraform_module_sources_user_id_fkey'
     ) then
    alter table public.terraform_module_sources
      add constraint terraform_module_sources_user_id_fkey
      foreign key (user_id)
      references auth.users(id)
      on delete cascade;
  end if;
end $$;

commit;
