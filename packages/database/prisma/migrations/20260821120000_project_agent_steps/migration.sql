-- What the running agent turn has done so far.
--
-- The finished reply already stores its steps in the message metadata, but that
-- row does not exist until the turn ends — so a turn that takes two minutes had
-- nowhere to report progress from, and the UI could only show a spinner. This is
-- the same `AgentStep[]`, written while the turn runs and cleared when it stops.
ALTER TABLE "public"."projects"
  ADD COLUMN "agent_steps" JSONB;
