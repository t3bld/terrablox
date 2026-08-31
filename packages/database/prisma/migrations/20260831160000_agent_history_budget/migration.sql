-- How much of a project's conversation is replayed into a turn, made a setting.
--
-- This is the agent's whole long-term memory. There is no vector store and no
-- summarisation: the newest messages are filled backwards into the prompt until
-- the budget runs out, and the rest is dropped. That works because the state of
-- the world is re-read from Git on every turn — the agent does not have to
-- remember what it built, it can see it — so what this budget covers is only what
-- was *said*: the decisions, the constraints, the reasons.
--
-- Which is exactly why it belongs to the user rather than to us. A long-running
-- project where the design was argued out in chat wants more of it; a scratch
-- project wants none of it in the way. The bounds live in the service
-- (2000..120000), because the ceiling is a judgement about sharing the model's
-- context window with the graph and the module library, not a database fact.
--
-- Nullable, no default, no backfill: null means "use the code default", so every
-- existing row keeps its 24000 characters without a write.
ALTER TABLE "public"."agent_settings"
  ADD COLUMN "history_budget_chars" INTEGER;
