-- Terrablox currently treats every signed-in account as an instance operator.
-- Keep the explicit role column and authorization checks so roles can be
-- restricted later without changing the administrative API boundary.
UPDATE "public"."user"
SET "system_role" = 'admin'
WHERE "system_role" = 'user';

ALTER TABLE "public"."user"
ALTER COLUMN "system_role" SET DEFAULT 'admin';
