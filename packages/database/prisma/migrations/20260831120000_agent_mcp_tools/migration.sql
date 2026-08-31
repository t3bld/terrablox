-- Per-tool control over a connected MCP server.
--
-- Enabling a server used to be all-or-nothing: the session was handed the server
-- and took whatever it advertised, including tools with side effects on somebody
-- else's system and any the server added later. That made "capability" a weaker
-- claim for MCP than for our own operations, where a switched-off tool is simply
-- never registered.
--
-- `tools` caches what the server said it has, fetched over MCP when it is added
-- and whenever the user refreshes. A cache, not a source of truth: the session is
-- configured from the remaining names, so a stale row can only withhold a tool,
-- never invent one.
--
-- `disabled_tools` is a deny list for the same reason every other tool switch
-- here is one — an allow list cannot distinguish "never configured" from
-- "deliberately empty", so servers added before this migration would silently
-- offer nothing at all.
--
-- No backfill: an existing server keeps working with an empty deny list, which is
-- exactly its behaviour before this column existed. Its `tools` stays NULL until
-- somebody opens the settings and refreshes, and the UI says "not checked yet"
-- rather than showing a server with no tools.
ALTER TABLE "public"."agent_mcp_servers"
  ADD COLUMN "tools" JSONB,
  ADD COLUMN "tools_synced_at" TIMESTAMPTZ(6),
  ADD COLUMN "disabled_tools" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
