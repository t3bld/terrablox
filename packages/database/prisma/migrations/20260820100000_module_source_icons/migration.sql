-- Where a module's icon comes from.
--
-- Two columns because they answer different questions: `icon_url` is what the
-- repository ships (an `icon.png` found at import), `icon_name` is what the user
-- picked from the bundled AWS set. Either can exist without the other, and the
-- resolver prefers the repository's own.
ALTER TABLE "public"."terraform_module_sources"
  ADD COLUMN "icon_url" TEXT,
  ADD COLUMN "icon_name" TEXT;
