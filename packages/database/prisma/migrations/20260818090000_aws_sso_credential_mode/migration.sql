-- AlterTable
ALTER TABLE "public"."aws_connections"
    ADD COLUMN "credential_mode" TEXT NOT NULL DEFAULT 'assume-role',
    ADD COLUMN "sso_start_url" TEXT,
    ADD COLUMN "sso_region" TEXT,
    ADD COLUMN "sso_role_name" TEXT,
    ADD COLUMN "sso_access_token" TEXT,
    ADD COLUMN "sso_expires_at" TIMESTAMPTZ(6);
