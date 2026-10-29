-- Module libraries: sets of module repositories Terrablox keeps in sync, as
-- configured in TERRABLOX_MODULE_LIBRARIES (e.g. "Terrablox", "Porsche").
--
-- `library` names the library a row was synced from; NULL is a user's own import.
-- A global library's rows have no owner and are shared by every user; a per-user
-- library's rows belong to the user whose GitHub token read them. Library rows
-- are read-only to users, and a library's `visible` flag hides them from every
-- read path without deleting anything.
ALTER TABLE "public"."terraform_module_sources" ADD COLUMN "library" TEXT;
ALTER TABLE "public"."terraform_modules" ADD COLUMN "library" TEXT;

-- A row without an owner is shared with everyone, so it must at least say which
-- library it belongs to. Keeping a per-user library's rows out of the shared set
-- is the read path's job: it admits ownerless rows only for libraries configured
-- as global, so a mislabelled private row is visible to nobody.
ALTER TABLE "public"."terraform_module_sources"
    ADD CONSTRAINT "terraform_module_sources_owner_or_library_check"
    CHECK ("user_id" IS NOT NULL OR "library" IS NOT NULL);
ALTER TABLE "public"."terraform_modules"
    ADD CONSTRAINT "terraform_modules_owner_or_library_check"
    CHECK ("user_id" IS NOT NULL OR "library" IS NOT NULL);

CREATE INDEX "terraform_module_sources_user_id_library_idx"
    ON "public"."terraform_module_sources"("user_id", "library");

-- Where one person's copy of a per-user library has got to: staleness, a short
-- lock so two tabs don't sync at once, and what discovery last learned.
CREATE TABLE "public"."module_library_syncs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "library" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'never',
    "installation_id" TEXT,
    "member_detected" BOOLEAN NOT NULL DEFAULT false,
    "repos" JSONB NOT NULL DEFAULT '{}',
    "pending" BOOLEAN NOT NULL DEFAULT false,
    "locked_until" TIMESTAMPTZ(6),
    "last_attempt_at" TIMESTAMPTZ(6),
    "last_synced_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "module_library_syncs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "module_library_syncs_user_id_library_key"
    ON "public"."module_library_syncs"("user_id", "library");
ALTER TABLE "public"."module_library_syncs"
    ADD CONSTRAINT "module_library_syncs_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "public"."user"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
