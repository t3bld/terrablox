-- CreateTable
CREATE TABLE "public"."resource_references" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "module_id" UUID NOT NULL,
    "from_address" TEXT NOT NULL,
    "from_kind" TEXT NOT NULL,
    "to_address" TEXT NOT NULL,
    "to_kind" TEXT NOT NULL,
    "attributes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "via_locals" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "resource_references_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "resource_references_module_id_idx" ON "public"."resource_references"("module_id");

-- CreateIndex
CREATE UNIQUE INDEX "resource_references_module_id_from_address_to_address_key" ON "public"."resource_references"("module_id", "from_address", "to_address");

-- AddForeignKey
ALTER TABLE "public"."resource_references" ADD CONSTRAINT "resource_references_module_id_fkey" FOREIGN KEY ("module_id") REFERENCES "public"."terraform_modules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
