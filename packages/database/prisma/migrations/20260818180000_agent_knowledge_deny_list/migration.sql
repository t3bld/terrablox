-- Knowledge sources the agent may not read, by id.
--
-- A deny list rather than an allow list. The `skills` column it replaces was an
-- allow list, which cannot distinguish "never configured" from "everything
-- switched off" — so every new install started with an agent that could see
-- neither its module library nor the project it was editing. With a deny list,
-- empty means everything is available, which is the right default.
ALTER TABLE "public"."agent_settings"
  ADD COLUMN "disabled_knowledge" TEXT[] NOT NULL DEFAULT '{}';

-- `skills` held ids of three prompt-snippet skills that no longer exist
-- (terraform-conventions, aws-landing-zone, least-privilege). Nothing reads the
-- column any more, and no id in it resolves to anything, so the data is dead.
ALTER TABLE "public"."agent_settings"
  DROP COLUMN "skills";
