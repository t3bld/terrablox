-- Adds a nullable display name/description for module versions.
--
-- We keep terraform_module_sources as the canonical store for the root module's
-- name/description, but allow terraform_modules (versions/submodules) to override
-- via optional columns.

begin;

alter table public.terraform_modules
  add column if not exists name text;

alter table public.terraform_modules
  add column if not exists description text;

commit;

