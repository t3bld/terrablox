-- Applied to Supabase via MCP migration `remove_legacy_module_storage`
--
-- Removes legacy upload/storage artifacts now that modules are sourced from Git.
-- Destructive: drops the per-file storage table and storage_root_path column.

begin;

-- Legacy file upload table (no longer used)
drop table if exists public.module_files cascade;

-- Legacy storage path on modules (no longer used)
alter table public.terraform_modules
  drop column if exists storage_root_path;

commit;
