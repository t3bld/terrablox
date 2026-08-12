-- A module has more than one diagram, and their node ids are unrelated. Without
-- a discriminator the second diagram to be arranged would overwrite the first.
ALTER TABLE "public"."module_graph_layouts" ADD COLUMN "graph" TEXT NOT NULL DEFAULT 'connections';

-- Existing rows were all written by the connections graph, which the column
-- default already records, so no backfill is needed.
DROP INDEX "public"."module_graph_layouts_user_id_module_id_key";

CREATE UNIQUE INDEX "module_graph_layouts_user_id_module_id_graph_key" ON "public"."module_graph_layouts"("user_id", "module_id", "graph");
