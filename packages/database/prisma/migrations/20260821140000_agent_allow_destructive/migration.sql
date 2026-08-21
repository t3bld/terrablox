-- Whether the agent may delete a module or a variable.
--
-- This replaces a sentence in the system prompt ("ask before doing anything
-- destructive"), which was advice the model could decline: the turn runs headless,
-- so the runtime's permission prompts are auto-approved and nobody was asked.
-- With this off — the default — the destructive operations are not registered on
-- the session, so the agent lacks the capability rather than being trusted with it.
--
-- Defaulting to false is a deliberate behaviour change for existing users: the
-- agent could remove modules before and now cannot until it is switched on.
ALTER TABLE "public"."agent_settings"
  ADD COLUMN "allow_destructive" BOOLEAN NOT NULL DEFAULT false;
