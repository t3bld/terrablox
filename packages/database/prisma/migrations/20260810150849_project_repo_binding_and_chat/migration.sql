-- AlterTable
ALTER TABLE "public"."projects" ADD COLUMN     "graph_positions" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "last_synced_at" TIMESTAMPTZ(6),
ADD COLUMN     "last_synced_sha" TEXT,
ADD COLUMN     "provider" TEXT NOT NULL DEFAULT 'github',
ADD COLUMN     "repo_branch" TEXT NOT NULL DEFAULT 'main',
-- Projects created before the repository binding existed have no repository to
-- name. They get an empty string rather than being dropped; the app treats that
-- as "not connected" and offers to bind one.
ADD COLUMN     "repo_full_name" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "repo_url" TEXT,
ADD COLUMN     "terraform_entry_file" TEXT NOT NULL DEFAULT 'main.tf',
ADD COLUMN     "terraform_root_folder" TEXT NOT NULL DEFAULT '.';

ALTER TABLE "public"."projects" ALTER COLUMN "repo_full_name" DROP DEFAULT;

-- CreateTable
CREATE TABLE "public"."project_chat_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_chat_messages_project_id_created_at_idx" ON "public"."project_chat_messages"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "projects_user_id_idx" ON "public"."projects"("user_id");

-- AddForeignKey
ALTER TABLE "public"."project_chat_messages" ADD CONSTRAINT "project_chat_messages_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
