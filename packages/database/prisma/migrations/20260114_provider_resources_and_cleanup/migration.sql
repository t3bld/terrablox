-- Applied to Supabase via MCP migration `provider_resources_and_cleanup`
--
-- Rename resource table and clean up legacy columns.

begin;

-- ---------------------------------
-- terraform_modules
-- submodules_root_folder -> terraform_submodules_folders (text[])
-- ---------------------------------

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='terraform_modules' and column_name='submodules_root_folder'
  ) then
    if not exists (
      select 1 from information_schema.columns
      where table_schema='public' and table_name='terraform_modules' and column_name='terraform_submodules_folders'
    ) then
      alter table public.terraform_modules
        rename column submodules_root_folder to terraform_submodules_folders;
    end if;
  end if;
end $$;

-- Convert to text[] if still text

do $$
declare
  col_udt text;
begin
  select udt_name into col_udt
  from information_schema.columns
  where table_schema='public'
    and table_name='terraform_modules'
    and column_name='terraform_submodules_folders';

  if col_udt = 'text' then
    alter table public.terraform_modules
      alter column terraform_submodules_folders
      type text[]
      using case
        when terraform_submodules_folders is null then array[]::text[]
        else array[terraform_submodules_folders]
      end;

    alter table public.terraform_modules
      alter column terraform_submodules_folders set default array[]::text[];

    update public.terraform_modules
      set terraform_submodules_folders = array[]::text[]
      where terraform_submodules_folders is null;
  elsif col_udt is null then
    -- Column doesn't exist yet; create it as an array.
    alter table public.terraform_modules
      add column terraform_submodules_folders text[] not null default array[]::text[];
  end if;
end $$;

-- ---------------------------------
-- used_modules: remove unused columns
-- ---------------------------------

alter table public.used_modules
  drop column if exists source_url,
  drop column if exists base_url,
  drop column if exists version,
  drop column if exists created_at;

-- ---------------------------------
-- terraform_resources -> provider_resources
-- plus column changes
-- ---------------------------------

do $$
begin
  if to_regclass('public.terraform_resources') is not null
     and to_regclass('public.provider_resources') is null then
    alter table public.terraform_resources rename to provider_resources;
  end if;
end $$;

-- Rename provider -> provider_name

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='provider_resources' and column_name='provider'
  ) then
    alter table public.provider_resources
      rename column provider to provider_name;
  end if;
end $$;

-- Drop removed columns
alter table public.provider_resources
  drop column if exists created_at,
  drop column if exists publisher;

-- Add new columns
alter table public.provider_resources
  add column if not exists resource_url text,
  add column if not exists provider_url text,
  add column if not exists resource_description text;

commit;
