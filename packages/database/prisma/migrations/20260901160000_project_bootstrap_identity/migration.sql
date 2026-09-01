ALTER TABLE "projects"
  ADD COLUMN "role_stack_name" TEXT,
  ADD COLUMN "state_stack_name" TEXT,
  ADD COLUMN "state_kms_alias" TEXT;

-- Pins the bootstrap's CloudFormation identity, instead of deriving it from the
-- project name on every call.
--
-- Nullable and backfilled from the old derivation, so a project set up before this
-- keeps looking at the same stacks it always did. The backfill has to reproduce
-- `slugify` exactly: lowercase, every run of characters outside [a-z0-9-] collapsed
-- to a single dash, leading and trailing dashes removed, and an empty result
-- becoming 'project'.
--
-- Only rows that have actually been set up are backfilled. A project with no role
-- and no bucket has never run the wizard, so it has no identity to preserve, and
-- writing one would pin a name derived from a name it may still change.
UPDATE "projects"
SET
  "role_stack_name"  = 'terrablox-' || slug.value || '-bootstrap',
  "state_stack_name" = 'terrablox-' || slug.value || '-state',
  "state_kms_alias"  = 'alias/terrablox-' || slug.value || '-state'
FROM (
  SELECT
    "id",
    COALESCE(
      NULLIF(
        TRIM(BOTH '-' FROM REGEXP_REPLACE(LOWER("name"), '[^a-z0-9-]+', '-', 'g')),
        ''
      ),
      'project'
    ) AS value
  FROM "projects"
) AS slug
WHERE "projects"."id" = slug."id"
  AND ("projects"."aws_role_arn" IS NOT NULL OR "projects"."state_bucket" IS NOT NULL);
