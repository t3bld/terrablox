-- Applied to Supabase via MCP migration `remove_terraform_modules_name`
--
-- Remove legacy `name` column from terraform_modules.
-- The module's display name should live on terraform_module_sources, not per version row.

begin;

alter table public.terraform_modules
  drop column if exists name;

commit;
