-- The module catalogue TerraBlox ships with.
--
-- A NULL `user_id` means "belongs to the installation, not to a person": every
-- user sees the row, nobody owns it, and no user can edit or delete it.
--
-- Dropping NOT NULL is enough to express that. Neither table has a foreign key
-- to `user`, so nothing cascades and no existing row changes: every row written
-- so far was written with a real user id and stays exactly as it is.
--
-- The safety property this relies on is that an equality filter never matches
-- NULL in SQL. Read paths opt in explicitly with `user_id = $1 OR user_id IS
-- NULL`; every write and delete path keeps its plain `user_id = $1` and so can
-- never reach a builtin.
ALTER TABLE "public"."terraform_module_sources"
  ALTER COLUMN "user_id" DROP NOT NULL;

ALTER TABLE "public"."terraform_modules"
  ALTER COLUMN "user_id" DROP NOT NULL;
