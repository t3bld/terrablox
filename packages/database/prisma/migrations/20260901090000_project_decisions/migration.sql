-- Why the infrastructure looks the way it does, and which operations implemented it.
--
-- The operation log already answers "what changed, when": one row per mutation,
-- with the commit it produced. What it cannot answer is *why*, and not because of
-- how it is grouped — because the reason was never written down anywhere durable.
-- It lived in the assistant's reply prose and in a step trail capped at forty
-- entries, and a turn that spent its whole budget lost the part that explained it.
--
-- Two grains, so two tables. One turn of the agent produced one decision about
-- where an application's data lives and twenty-nine operations implementing it,
-- across two messages. Neither table can be derived from the other: the decision
-- outlives the turn, and the operations outnumber it.
--
-- The shape follows an architecture decision record, for its reasons rather than
-- its name. `context` holds the requirements as they were understood — the field a
-- reader corrects first, because a misread requirement is cheaper to fix there than
-- in a deployed VPC. `alternatives` holds what lost and why, which is the part of a
-- decision that stops it being re-litigated three turns later. And a decision is
-- never edited: `superseded_by_id` points at the one that replaced it, so the log
-- keeps saying what was believed at the time.
--
-- `plan` is kept apart from the operations on purpose. It is the intent as declared,
-- and the difference between it and what followed is the interesting part: ten
-- modules planned, ten added, no wires drawn.
CREATE TABLE "public"."project_decisions" (
  "id"                UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id"        UUID NOT NULL,
  "origin"            TEXT NOT NULL,
  "question"          TEXT NOT NULL,
  "context"           TEXT NOT NULL,
  "choice"            TEXT NOT NULL,
  "reason"            TEXT NOT NULL,
  "alternatives"      JSONB NOT NULL DEFAULT '[]',
  "plan"              JSONB NOT NULL DEFAULT '{}',
  "status"            TEXT NOT NULL DEFAULT 'active',
  "superseded_by_id"  UUID,
  "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "project_decisions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "project_decisions_project_id_created_at_idx"
  ON "public"."project_decisions" ("project_id", "created_at");

ALTER TABLE "public"."project_decisions"
  ADD CONSTRAINT "project_decisions_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "public"."projects" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Self-reference: SET NULL rather than CASCADE, because deleting the decision that
-- replaced an older one must not delete the older one too.
ALTER TABLE "public"."project_decisions"
  ADD CONSTRAINT "project_decisions_superseded_by_id_fkey"
  FOREIGN KEY ("superseded_by_id") REFERENCES "public"."project_decisions" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Which turn an operation came from, and which decision it serves.
--
-- Both nullable and not backfilled. A canvas edit is one gesture and belongs to
-- neither; every row written before today belongs to neither either, and the log
-- shows those for what they are — changes with no recorded reason. Inventing a
-- grouping for them from timestamps would be a guess presented as provenance.
--
-- SET NULL on both: losing a conversation, or a decision, must not lose the record
-- of what actually reached the repository. The repository is the source of truth
-- and this table is the index into it.
ALTER TABLE "public"."project_operations"
  ADD COLUMN "chat_message_id" UUID,
  ADD COLUMN "decision_id"     UUID;

CREATE INDEX "project_operations_chat_message_id_idx"
  ON "public"."project_operations" ("chat_message_id");

CREATE INDEX "project_operations_decision_id_idx"
  ON "public"."project_operations" ("decision_id");

ALTER TABLE "public"."project_operations"
  ADD CONSTRAINT "project_operations_chat_message_id_fkey"
  FOREIGN KEY ("chat_message_id") REFERENCES "public"."project_chat_messages" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "public"."project_operations"
  ADD CONSTRAINT "project_operations_decision_id_fkey"
  FOREIGN KEY ("decision_id") REFERENCES "public"."project_decisions" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
