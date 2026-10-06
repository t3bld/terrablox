-- Encrypts the AWS credentials that were stored in plain text.
--
-- Four values could be redeemed by anyone holding a copy of this database: the
-- IAM Identity Center access token on a connection, and the client secret, device
-- code and access token of a login in flight. The access token alone is enough to
-- issue role credentials in every AWS account the user can reach.
--
-- The old values cannot be migrated. Encryption happens in the application, with
-- a key derived from BETTER_AUTH_SECRET, and SQL has no access to it — so the
-- plaintext is destroyed rather than converted, and the sessions it belonged to
-- are ended.
--
-- Who notices: only `sso`-mode connections, which is the self-hosted case where
-- TerraBlox has no AWS identity of its own. They have to sign in again, which is
-- the same thing they already do every few hours when the token expires normally.
-- `assume-role` connections hold no token at all and are untouched.

-- 1. Logins in flight. These rows live at most fifteen minutes and are deleted on
--    completion anyway, so there is nothing here worth carrying across. Deleting
--    them beats leaving rows whose secrets no longer decrypt.
DELETE FROM "public"."aws_sso_logins";

ALTER TABLE "public"."aws_sso_logins"
  DROP COLUMN "client_secret",
  DROP COLUMN "device_code",
  DROP COLUMN "access_token",
  ADD COLUMN "client_secret_ciphertext" TEXT NOT NULL,
  ADD COLUMN "device_code_ciphertext" TEXT NOT NULL,
  ADD COLUMN "access_token_ciphertext" TEXT;

-- 2. Connections. End the sign-in before dropping the token it depended on, so
--    the UI reports "expired" and offers the sign-in button, instead of reporting
--    a healthy connection that fails on first use. `read_project_aws_state` reads
--    exactly this column to decide.
UPDATE "public"."aws_connections"
   SET "sso_expires_at" = now()
 WHERE "sso_access_token" IS NOT NULL;

ALTER TABLE "public"."aws_connections"
  DROP COLUMN "sso_access_token",
  ADD COLUMN "sso_access_token_ciphertext" TEXT;
