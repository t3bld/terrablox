-- Which icon a module shows: the one its repository ships, one picked from the
-- bundled AWS set, or none.
--
-- Needed because `icon_url` and `icon_name` can both be set, and preferring one
-- silently leaves two things unsayable: "show the plain mark even though there is
-- an icon", and "show the AWS one even though the repository ships a picture".
--
-- Default 'repo' reproduces the behaviour every existing row already had.
ALTER TABLE "public"."terraform_module_sources"
  ADD COLUMN "icon_mode" TEXT NOT NULL DEFAULT 'repo';

-- Enumerated in the database as well as in the application: the value is read
-- back into a union type, and a typo written by some future script would surface
-- as a module with no icon rather than as an error.
ALTER TABLE "public"."terraform_module_sources"
  ADD CONSTRAINT "terraform_module_sources_icon_mode_check"
  CHECK ("icon_mode" IN ('repo', 'aws', 'none'));
