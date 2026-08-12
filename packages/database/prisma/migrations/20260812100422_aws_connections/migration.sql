-- CreateTable
CREATE TABLE "public"."aws_connections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "account_id" TEXT,
    "role_arn" TEXT NOT NULL,
    "region" TEXT NOT NULL DEFAULT 'eu-central-1',
    "external_id" TEXT NOT NULL,
    "verified_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "aws_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "aws_connections_user_id_idx" ON "public"."aws_connections"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "aws_connections_user_id_role_arn_key" ON "public"."aws_connections"("user_id", "role_arn");

-- AddForeignKey
ALTER TABLE "public"."aws_connections" ADD CONSTRAINT "aws_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
