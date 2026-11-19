-- How a project signs in to AWS through IAM Identity Center, kept on the
-- project so it survives an expired or disconnected sign-in.
ALTER TABLE "public"."projects" ADD COLUMN "aws_sso_start_url" TEXT;
ALTER TABLE "public"."projects" ADD COLUMN "aws_sso_region" TEXT;
ALTER TABLE "public"."projects" ADD COLUMN "aws_sso_role_name" TEXT;
ALTER TABLE "public"."projects" ADD COLUMN "aws_account_label" TEXT;

-- Backfill from each project's current sign-in, where there is one.
UPDATE "public"."projects" p
SET "aws_sso_start_url" = c."sso_start_url",
    "aws_sso_region"    = c."sso_region",
    "aws_sso_role_name" = c."sso_role_name",
    "aws_account_label" = NULLIF(c."label", '')
FROM (
  SELECT DISTINCT ON ("user_id", "account_id") *
  FROM "public"."aws_connections"
  WHERE "credential_mode" = 'sso' AND "sso_start_url" IS NOT NULL
  ORDER BY "user_id", "account_id", "verified_at" DESC NULLS LAST, "created_at" DESC
) c
WHERE c."user_id" = p."user_id" AND c."account_id" = p."aws_account_id";
