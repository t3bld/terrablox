-- The per-turn budgets, made settings.
--
-- Both were fixed constants, and the harness screen said so in as many words:
-- "Not a setting: raising it only lets one turn make a change nobody reviewed."
-- That argument holds for raising the operation budget and says nothing about
-- lowering it — a user who wants the agent to report back after every single edit
-- had no way to ask, and a user with genuinely large projects had no way to let a
-- turn finish. The bounds live in the service (1..100 for both), so the range
-- stays reviewable in code rather than in a check constraint nobody reads.
--
-- Nullable with no default and no backfill: null means "use the code default", so
-- every existing row keeps behaving exactly as it did — 25 operations and 20 MCP
-- calls — without a write.
ALTER TABLE "public"."agent_settings"
  ADD COLUMN "max_tool_calls" INTEGER,
  ADD COLUMN "max_mcp_calls" INTEGER;
