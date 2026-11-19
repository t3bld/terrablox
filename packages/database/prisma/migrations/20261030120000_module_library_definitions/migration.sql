-- Persist normalized module-library definitions. Imported module/source rows keep
-- their library ids as plain text on purpose: disabling or deleting a definition
-- must hide, not cascade-delete, already imported data.
ALTER TABLE "public"."user"
ADD COLUMN "system_role" TEXT NOT NULL DEFAULT 'user';

ALTER TABLE "public"."user"
ADD CONSTRAINT "user_system_role_check"
CHECK ("system_role" IN ('user', 'admin'));

CREATE TABLE "public"."module_library_definitions" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "org" TEXT NOT NULL,
    "topics" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "prefix" TEXT,
    "public_only" BOOLEAN NOT NULL DEFAULT true,
    "submodule_container" TEXT,
    "pipeline_secret" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "module_library_definitions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "module_library_definitions_id_check"
        CHECK ("id" ~ '^[a-z][a-z0-9-]{1,31}$'),
    CONSTRAINT "module_library_definitions_name_check"
        CHECK (length(btrim("name")) BETWEEN 1 AND 40 AND "name" = btrim("name")),
    CONSTRAINT "module_library_definitions_scope_check"
        CHECK ("scope" IN ('global', 'user')),
    CONSTRAINT "module_library_definitions_org_check"
        CHECK ("org" ~ '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$'),
    CONSTRAINT "module_library_definitions_topics_check"
        CHECK (
            cardinality("topics") <= 10
            AND (
                cardinality("topics") = 0
                OR array_to_string("topics", ',') ~ '^[a-z0-9][a-z0-9-]{0,49}(,[a-z0-9][a-z0-9-]{0,49})*$'
            )
        ),
    CONSTRAINT "module_library_definitions_prefix_check"
        CHECK ("prefix" IS NULL OR "prefix" ~ '^[A-Za-z0-9._-]{1,100}$'),
    CONSTRAINT "module_library_definitions_selector_check"
        CHECK (cardinality("topics") > 0 OR "prefix" IS NOT NULL),
    CONSTRAINT "module_library_definitions_public_only_check"
        CHECK ("scope" = 'global' OR "public_only" = false),
    CONSTRAINT "module_library_definitions_submodule_container_check"
        CHECK (
            "submodule_container" IS NULL
            OR (
                "submodule_container" ~ '^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$'
                AND NOT (string_to_array("submodule_container", '/') @> ARRAY['..']::TEXT[])
            )
        ),
    CONSTRAINT "module_library_definitions_pipeline_secret_check"
        CHECK (
            "pipeline_secret" ~ '^[A-Z][A-Z0-9_]{0,99}$'
            AND "pipeline_secret" !~ '^GITHUB_'
        ),
    CONSTRAINT "module_library_definitions_sort_order_check"
        CHECK ("sort_order" >= 0)
);

CREATE UNIQUE INDEX "module_library_definitions_scope_org_key"
    ON "public"."module_library_definitions"("scope", lower("org"));
CREATE INDEX "module_library_definitions_active_sort_order_id_idx"
    ON "public"."module_library_definitions"("active", "sort_order", "id");

-- Exact normalized definitions effective in the current TERRABLOX_MODULE_LIBRARIES
-- configuration when this migration was authored. pipeline_secret stores names,
-- never secret values.
INSERT INTO "public"."module_library_definitions" (
    "id", "name", "scope", "visible", "active", "org", "topics", "prefix",
    "public_only", "submodule_container", "pipeline_secret", "sort_order"
) VALUES
    (
        'terrablox', 'Terrablox', 'global', true, true, 'terrablox', ARRAY[]::TEXT[],
        'terrablox-aws-', true, 'modules', 'TERRABLOX_TERRABLOX_MODULES_TOKEN', 0
    ),
    (
        'porsche', 'Porsche', 'user', true, true, 'porsche-code', ARRAY['aws', 'cbbac']::TEXT[],
        NULL, false, NULL, 'TERRABLOX_PORSCHE_MODULES_TOKEN', 1
    );
