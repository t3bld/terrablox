-- Tracks whether the agent is currently processing a turn for this project.
-- Survives navigation so the chat panel can show a spinner on re-mount.
ALTER TABLE "public"."projects"
  ADD COLUMN "agent_running" BOOLEAN NOT NULL DEFAULT false;
