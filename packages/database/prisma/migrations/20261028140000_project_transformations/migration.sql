-- Project transformations: one agent turn captured whole, as training data for
-- the harness.
--
-- The reply and step trail already live on project_chat_messages, the reasoning on
-- project_decisions and the applied edits on project_operations, but none of them
-- keeps the graph the turn started from, so the before/after pair cannot be
-- reconstructed afterwards. This table is the one place that holds it: the prompt
-- and the conditions it ran under, the graph before and after, the trajectory in
-- between, and an outcome signal backfilled once the pipeline has judged the
-- commit. migration_source holds what the turn migrated FROM when that was not the
-- graph: the app-repo files and MCP calls a legacy/on-prem migration starts from,
-- captured in full because the step trail only summarises them.
--
-- Written fire-and-forget after a turn commits; only turns that changed something
-- are recorded. Additive: no existing table or column is touched.
CREATE TABLE "public"."project_transformations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "chat_message_id" UUID,
    "prompt" TEXT NOT NULL,
    "reply" TEXT NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "graph_before" JSONB NOT NULL DEFAULT '{}',
    "graph_after" JSONB NOT NULL DEFAULT '{}',
    "steps" JSONB NOT NULL DEFAULT '[]',
    "mutations" JSONB NOT NULL DEFAULT '[]',
    "decisions" JSONB NOT NULL DEFAULT '[]',
    "migration_source" JSONB NOT NULL DEFAULT '{}',
    "commits" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "mutation_errors" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "outcome" TEXT NOT NULL DEFAULT 'completed',
    "pipeline_conclusion" TEXT,
    "pipeline_checked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "project_transformations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "project_transformations_project_id_created_at_idx"
    ON "public"."project_transformations"("project_id", "created_at");
CREATE INDEX "project_transformations_user_id_created_at_idx"
    ON "public"."project_transformations"("user_id", "created_at");

ALTER TABLE "public"."project_transformations"
    ADD CONSTRAINT "project_transformations_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
