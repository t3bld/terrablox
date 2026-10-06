import { createMcpHandler } from "@modelcontextprotocol/server";

import { requireCaller } from "@/lib/api/guard";
import { RATE_LIMITS } from "@/lib/api/rate-limit";
import { routeError } from "@/lib/api/route-error";
import { createDashboardMcpServer } from "@/lib/mcp/server";

/**
 * The dashboard, as an MCP endpoint.
 *
 * Streamable HTTP rather than a stdio process, because the operations live here: the
 * services are `server-only` and hold a Prisma client, and the agent path spawns a
 * Copilot CLI child from a process singleton. A separate process would have to either
 * duplicate the database layer or speak HTTP back to this one — which means solving
 * authentication twice and running the rate limiter twice, each with its own budget.
 *
 * Authentication happens *here*, before the protocol is touched. The SDK is explicit
 * that its handler performs no token verification and passes `authInfo` through
 * untouched, so there is no per-tool auth to forget: the caller is resolved once and
 * baked into the server instance, and no tool takes a user id at all.
 *
 * The scope is checked per tool, not here. This endpoint was briefly declared
 * `write: true` as a whole, which authenticated cleanly and then made a read-only token
 * useless: it could not even open a connection, while the settings screen offers
 * read-only as the *default*. A token that fails at the door is worse than no token, so
 * the check moved to the handlers, where it is known whether a call changes anything.
 */

/**
 * Node, not Edge. The services underneath reach Prisma and `node:crypto`, neither of
 * which exists on the Edge runtime — and the token hash is computed with the latter.
 */
export const runtime = "nodejs";

/**
 * Never cached, and never statically analysed for caching.
 *
 * A route that reads `Authorization` and answers differently per caller is the exact
 * shape Next's default caching would get wrong, and the failure mode — one user's
 * project list served to another — is the worst one available.
 */
export const dynamic = "force-dynamic";

async function serve(request: Request): Promise<Response> {
  let handler: ReturnType<typeof createMcpHandler> | null = null;

  try {
    const caller = await requireCaller({
      request,
      scope: "mcp.call",
      // Its own budget, because the unit here is a protocol message rather than a user
      // action: `initialize`, `tools/list` and every tool call each cost one. Pointed at
      // the `infrastructure` budget this endpoint ran out three steps into a task.
      limit: RATE_LIMITS.mcp,
      // Authentication only. Whether this caller may *change* anything is decided by
      // each tool, so a read-only token can still read.
    });

    // A factory per request, closing over the authenticated caller. The SDK calls it
    // once per connection and pins that instance, so the identity cannot drift
    // mid-session — and because the closure is the only source of a user id, a tool
    // has no way to name somebody else.
    handler = createMcpHandler(() => createDashboardMcpServer(caller));

    return await handler.fetch(request);
  } catch (error) {
    return routeError("mcp", error);
  } finally {
    // Releases the per-request instances the modern leg holds. Skipping this leaks a
    // server object per request, which on a long-lived container is a slow leak rather
    // than a visible failure — the kind worth closing in a `finally`.
    await handler?.close().catch(() => {});
  }
}

export const POST = serve;

/**
 * GET and DELETE belong to the protocol's session handling, so they are forwarded too.
 *
 * A client that opens a stream or tears a session down must reach the same handler;
 * answering 405 here would work for the stateless case and break the moment a host
 * negotiates a session.
 */
export const GET = serve;
export const DELETE = serve;
