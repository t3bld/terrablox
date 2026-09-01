-- Four per-turn limits that were constants in the code become settings.
--
-- Nullable with no default, like every other dial on AgentSettings: null is a
-- value in its own right and means "follow the default", so the default itself
-- stays in `runtime-options.ts` where it is documented and can be changed in one
-- place. A column default would put a second copy of each number in the database,
-- and the copy that rows were created with would go stale the first time the code
-- default moved.
ALTER TABLE "agent_settings"
  ADD COLUMN "max_steps" INTEGER,
  ADD COLUMN "max_app_repo_reads" INTEGER,
  ADD COLUMN "app_repo_tree_limit" INTEGER,
  ADD COLUMN "app_repo_file_chars" INTEGER;
