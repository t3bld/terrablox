-- AlterTable
ALTER TABLE "public"."agent_settings" ADD COLUMN     "disabled_tools" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "public"."projects" ADD COLUMN     "agent_overrides" JSONB;
