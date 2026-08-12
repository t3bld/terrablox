-- CreateTable
CREATE TABLE "public"."aws_sso_logins" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "start_url" TEXT NOT NULL,
    "sso_region" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_secret" TEXT NOT NULL,
    "device_code" TEXT NOT NULL,
    "interval" INTEGER NOT NULL DEFAULT 5,
    "access_token" TEXT,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "aws_sso_logins_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "aws_sso_logins_user_id_idx" ON "public"."aws_sso_logins"("user_id");

-- AddForeignKey
ALTER TABLE "public"."aws_sso_logins" ADD CONSTRAINT "aws_sso_logins_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
