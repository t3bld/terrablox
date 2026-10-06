import { NextResponse } from "next/server";

import {
  AgentSettingsError,
  syncMcpServerTools,
} from "@/lib/agent/settings-service";
import { requireUserWithLimit } from "@/lib/api/guard";
import { badRequest, routeError } from "@/lib/api/route-error";

/**
 * Re-reads one server's tool catalogue.
 *
 * A POST rather than a GET, and its own endpoint rather than a field on the
 * server: it makes an outbound request to a third party and writes what comes
 * back, so it is an action with an effect, not a projection of stored state. That
 * also keeps it off the path that renders the settings page — drawing a screen
 * must not depend on a vendor's endpoint being up.
 *
 * A server whose catalogue cannot be read still answers 200 with `toolsProblem`
 * set. The failure belongs to the connection, not to this request, and the client
 * needs the server row back either way to keep showing the list it had.
 */
export async function POST(
  _request: Request,
  { params }: { params: { serverId: string } },
) {
  try {
    // Rate limited because it is an outbound request to a third party made from our
    // network, on the user's stored credential. Unbounded, it is a way to have this
    // server hammer somebody else's endpoint.
    const userId = await requireUserWithLimit("agent.mcp.sync");

    const { server, toolsProblem } = await syncMcpServerTools(
      userId,
      params.serverId,
    );

    return NextResponse.json({ ...server, toolsProblem });
  } catch (error) {
    if (error instanceof AgentSettingsError) {
      return badRequest(error.message);
    }
    return routeError("agent.mcp.sync", error);
  }
}
