-- CreateTable
CREATE TABLE "public"."module_graph_layouts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "module_id" UUID NOT NULL,
    "positions" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "module_graph_layouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "module_graph_layouts_user_id_module_id_key" ON "public"."module_graph_layouts"("user_id", "module_id");

-- AddForeignKey
ALTER TABLE "public"."module_graph_layouts" ADD CONSTRAINT "module_graph_layouts_module_id_fkey" FOREIGN KEY ("module_id") REFERENCES "public"."terraform_modules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
