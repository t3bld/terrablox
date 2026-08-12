-- AlterTable
ALTER TABLE "public"."projects" ADD COLUMN     "aws_account_id" TEXT,
ADD COLUMN     "aws_region" TEXT NOT NULL DEFAULT 'eu-central-1',
ADD COLUMN     "aws_role_arn" TEXT,
ADD COLUMN     "state_bucket" TEXT,
ADD COLUMN     "state_lock_table" TEXT;
