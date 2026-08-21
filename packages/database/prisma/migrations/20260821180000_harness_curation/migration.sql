-- Editable overrides for the harness texts that are otherwise hard-coded.
--
-- A single row holding one JSON object, not a table per curated list. The shape
-- changes whenever a new field becomes editable, and a schema migration per field
-- would be a migration for a text change. The reader validates instead: anything
-- it does not recognise is dropped, so an override left behind by a removed field
-- cannot reach a prompt.
--
-- Deliberately only overrides. The defaults stay in the source, which means an
-- empty table reproduces exactly the behaviour of the code — and deleting a row
-- is a working undo rather than a data loss.
CREATE TABLE "public"."harness_curation" (
  "id"         TEXT NOT NULL,
  "overrides"  JSONB NOT NULL DEFAULT '{}',
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_by" UUID,

  CONSTRAINT "harness_curation_pkey" PRIMARY KEY ("id")
);
