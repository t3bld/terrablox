-- The application repository a project builds infrastructure for.
--
-- Read-only to TerraBlox: nothing is ever committed here, and it is not the
-- project's source of truth — `repo_full_name` stays that. It exists so the agent
-- can look at how the application is actually built before proposing what it
-- needs, instead of asking a user to describe their own codebase in a chat box.
--
-- Nullable with no default, and no backfill: a project without a link is a
-- working project. The agent simply has to ask rather than read, and the prompt
-- says so.
ALTER TABLE "public"."projects"
  ADD COLUMN "app_repo_full_name" TEXT,
  ADD COLUMN "app_repo_branch" TEXT;
