-- The KMS key the state bucket encrypts with.
--
-- Stored rather than derived: reading the state back needs `kms:Decrypt` on this
-- exact key ARN, and an alias would not be enough to scope a session policy to.
ALTER TABLE "public"."projects"
  ADD COLUMN "state_kms_key_arn" TEXT;

-- How the project's deployment workflows are configured.
--
-- Nullable rather than defaulted to '{}': the catalogue owns the defaults, and a
-- project that has never been configured must be distinguishable from one that
-- was configured to exactly the defaults.
ALTER TABLE "public"."projects"
  ADD COLUMN "deploy_templates" JSONB;
