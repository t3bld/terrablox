-- Remembers that somebody asked an organisation owner to approve the GitHub App.
--
-- GitHub will not tell us this. A member without admin rights on an organisation
-- cannot install the app: GitHub files a request for an owner to approve and sends the
-- user back with `setup_action=request` and no installation. A pending request is not
-- an installation, so it shows up in no endpoint reachable with a user token — listing
-- them needs app-level auth with the app's private key, which a self-hosted instance
-- deliberately does not hold.
--
-- Nullable with no default and no backfill: existing users have not asked, and NULL is
-- exactly that. Cleared again the moment an installation is observed.
ALTER TABLE "public"."user"
    ADD COLUMN "github_install_requested_at" TIMESTAMPTZ(6);
