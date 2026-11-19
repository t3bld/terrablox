-- The role an IAM-only SSO sign-in assumes to run the deployment setup.
ALTER TABLE "public"."aws_connections" ADD COLUMN "sso_setup_role_arn" TEXT;
