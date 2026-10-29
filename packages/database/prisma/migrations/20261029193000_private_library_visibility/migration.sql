-- Every per-user library row must have the sync record that controls whether it is visible.
-- Preserve any legacy rows by attaching a non-readable error state rather than deleting them.
INSERT INTO "public"."module_library_syncs" ("user_id", "library", "state", "pending")
SELECT DISTINCT candidate."user_id", candidate."library", 'error', false
FROM (
  SELECT "user_id", "library"
  FROM "public"."terraform_module_sources"
  WHERE "user_id" IS NOT NULL AND "library" IS NOT NULL
  UNION
  SELECT "user_id", "library"
  FROM "public"."terraform_modules"
  WHERE "user_id" IS NOT NULL AND "library" IS NOT NULL
) AS candidate
ON CONFLICT ("user_id", "library") DO NOTHING;

ALTER TABLE "public"."module_library_syncs"
ADD COLUMN "lock_id" UUID;

CREATE INDEX "terraform_modules_user_id_library_idx"
ON "public"."terraform_modules"("user_id", "library");

ALTER TABLE "public"."terraform_module_sources"
ADD CONSTRAINT "terraform_module_sources_user_id_library_fkey"
FOREIGN KEY ("user_id", "library")
REFERENCES "public"."module_library_syncs"("user_id", "library")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."terraform_modules"
ADD CONSTRAINT "terraform_modules_user_id_library_fkey"
FOREIGN KEY ("user_id", "library")
REFERENCES "public"."module_library_syncs"("user_id", "library")
ON DELETE CASCADE ON UPDATE CASCADE;
