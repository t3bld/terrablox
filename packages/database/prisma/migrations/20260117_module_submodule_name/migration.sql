-- Applied to Supabase via MCP migration `module_submodule_name`
--
-- Replace terraform_modules.name/description with terraform_modules.submodule_name.
-- Root module display name/description live on terraform_module_sources.
-- Submodules can optionally store a submodule_name for display.

begin;

-- 1) Add submodule_name (nullable)
alter table public.terraform_modules
  add column if not exists submodule_name text;

-- 2) Backfill from legacy columns if they exist
-- If `name` exists, copy it into submodule_name where this row is a submodule.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'terraform_modules' and column_name = 'name'
  ) then
    update public.terraform_modules
      set submodule_name = coalesce(submodule_name, name)
      where is_submodule = true;
  end if;
end
$$;

-- 3) Drop legacy columns
alter table public.terraform_modules
  drop column if exists name;

alter table public.terraform_modules
  drop column if exists description;

commit;

