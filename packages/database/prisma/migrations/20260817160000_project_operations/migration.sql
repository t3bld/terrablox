-- CreateTable
CREATE TABLE "public"."project_operations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "origin" TEXT NOT NULL,
    "mutation" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "commit_sha" TEXT,
    "parent_sha" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_operations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_operations_project_id_created_at_idx" ON "public"."project_operations"("project_id", "created_at");

-- AddForeignKey
ALTER TABLE "public"."project_operations" ADD CONSTRAINT "project_operations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
