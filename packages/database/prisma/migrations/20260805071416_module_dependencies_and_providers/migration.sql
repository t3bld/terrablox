-- AlterTable
ALTER TABLE "public"."provider_resources" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'resource',
ADD COLUMN     "source_file" TEXT;

-- CreateTable
CREATE TABLE "public"."module_dependencies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "module_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "source" TEXT,
    "version" TEXT,
    "source_kind" TEXT NOT NULL DEFAULT 'unknown',
    "registry_url" TEXT,
    "source_file" TEXT,

    CONSTRAINT "module_dependencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."module_providers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "module_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "source" TEXT,
    "version" TEXT,
    "docs_url" TEXT,

    CONSTRAINT "module_providers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "module_dependencies_module_id_idx" ON "public"."module_dependencies"("module_id");

-- CreateIndex
CREATE UNIQUE INDEX "module_dependencies_module_id_name_key" ON "public"."module_dependencies"("module_id", "name");

-- CreateIndex
CREATE INDEX "module_providers_module_id_idx" ON "public"."module_providers"("module_id");

-- CreateIndex
CREATE UNIQUE INDEX "module_providers_module_id_name_key" ON "public"."module_providers"("module_id", "name");

-- CreateIndex
CREATE INDEX "provider_resources_module_id_idx" ON "public"."provider_resources"("module_id");

-- AddForeignKey
ALTER TABLE "public"."module_dependencies" ADD CONSTRAINT "module_dependencies_module_id_fkey" FOREIGN KEY ("module_id") REFERENCES "public"."terraform_modules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."module_providers" ADD CONSTRAINT "module_providers_module_id_fkey" FOREIGN KEY ("module_id") REFERENCES "public"."terraform_modules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
