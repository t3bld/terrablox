-- Personal tokens, so something other than a browser can act as a user.
--
-- Every route in this app authenticates with a session cookie. That is the right
-- default and it rules out the one client that now needs in: an MCP host. A coding
-- agent in an editor cannot hold a cookie, and `sameSite` — the thing that makes the
-- cookie safe — is precisely what keeps it out.
--
-- Hashed rather than encrypted. `headers_ciphertext` on agent_mcp_servers is
-- encrypted because those are credentials for somebody else's system and have to be
-- replayed. This one is only ever compared against, so the plaintext is shown once at
-- creation and stored nowhere: a database dump yields no usable token, and there is no
-- key whose loss would matter.
CREATE TABLE "public"."api_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    -- SHA-256, hex. A plain hash and not a slow KDF: the input is 256 bits of
    -- randomness, so there is no dictionary to attack and nothing to stretch, and a
    -- fast hash keeps verification a single indexed equality.
    "token_hash" TEXT NOT NULL,
    -- The leading characters, for recognising a token whose secret is unreadable.
    "token_prefix" TEXT NOT NULL,
    "scopes" TEXT[] NOT NULL DEFAULT ARRAY['read']::TEXT[],
    -- Null means it never expires, which is an honest state for a workstation setup
    -- rather than a fake deadline somebody extends without thinking.
    "expires_at" TIMESTAMPTZ(6),
    -- Coarse, and only so somebody can find the token they stopped using. Activity
    -- tracing is the audit trail's job.
    "last_used_at" TIMESTAMPTZ(6),
    -- Set instead of deleting, so the row stays for the audit trail to point at.
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_tokens_pkey" PRIMARY KEY ("id")
);

-- Unique, because verification looks a token up by its hash alone. Two rows with the
-- same hash would be the same secret, which cannot happen by chance and must not be
-- creatable on purpose.
CREATE UNIQUE INDEX "api_tokens_token_hash_key" ON "public"."api_tokens"("token_hash");

-- One name per person, so "which of these do I revoke?" has an answer.
CREATE UNIQUE INDEX "api_tokens_user_id_name_key" ON "public"."api_tokens"("user_id", "name");

CREATE INDEX "api_tokens_user_id_idx" ON "public"."api_tokens"("user_id");

ALTER TABLE "public"."api_tokens"
    ADD CONSTRAINT "api_tokens_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "public"."user"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
