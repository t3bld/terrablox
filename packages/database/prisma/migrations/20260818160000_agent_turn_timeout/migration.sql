-- How long a single agent turn may run, in seconds.
-- NULL means "use the default" (currently 300s / 5 minutes).
ALTER TABLE "public"."agent_settings"
  ADD COLUMN "turn_timeout" INTEGER;
