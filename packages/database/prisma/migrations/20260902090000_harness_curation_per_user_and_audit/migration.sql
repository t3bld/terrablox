-- Harness curation becomes per user, and an audit trail arrives.
--
-- The harness table used to hold exactly one row with id = 'default'. That made
-- the agent's operating rules an installation-wide setting which any signed-in
-- account could rewrite, and those rules go into every user's system prompt — so
-- it was a way to put text into other people's agent runs. There is no role model
-- and no tenant entity in this schema, so "per user" is the only scope that can
-- actually be enforced by a where-clause.

-- The old singleton is dropped rather than migrated onto a user.
--
-- Deliberate, and the reason is that there is no correct owner to pick. `updated_by`
-- recorded whoever saved last, which is provenance, not ownership: assigning the row
-- to that person would silently hand one account's wording to a user who never chose
-- it, and assigning it to nobody would leave an orphan. An absent row already means
-- "the code defaults", so dropping is the one outcome that is both defined and
-- visible — every user starts from the defaults and re-enters their own overrides.
DROP TABLE IF EXISTS "public"."harness_curation";

CREATE TABLE "public"."harness_curation" (
    "user_id" UUID NOT NULL,
    "overrides" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "harness_curation_pkey" PRIMARY KEY ("user_id")
);

ALTER TABLE "public"."harness_curation"
    ADD CONSTRAINT "harness_curation_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "public"."user"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- The Infracost credential store, dropped for good.
--
-- The cost feature was removed earlier and this table has had no reader or writer
-- since. It held API keys users entered themselves, so leaving it in place meant
-- carrying live third-party credentials that no code path could ever use, rotate
-- or show them. Dropping destroys those keys, which is the point: an unused
-- credential is a liability, and the users' own Infracost accounts are unaffected.
DROP TABLE IF EXISTS "public"."infracost_settings";

-- Security events, append-only by convention.
CREATE TABLE "public"."audit_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID,
    "action" TEXT NOT NULL,
    "subject" TEXT,
    "outcome" TEXT NOT NULL DEFAULT 'ok',
    "ip" TEXT,
    "user_agent" TEXT,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "audit_events_user_id_created_at_idx"
    ON "public"."audit_events"("user_id", "created_at");
CREATE INDEX "audit_events_action_created_at_idx"
    ON "public"."audit_events"("action", "created_at");

-- SET NULL rather than CASCADE: deleting an account must not erase the record of
-- what it did. The rows are meant to outlive the user.
ALTER TABLE "public"."audit_events"
    ADD CONSTRAINT "audit_events_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "public"."user"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
