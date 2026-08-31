import { NextResponse } from "next/server";

import {
  AgentSettingsError,
  syncMcpServerTools,
} from "@/lib/agent/settings-service";
import { getCurrentUserId } from "@/lib/auth/server-helpers";

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
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { server, toolsProblem } = await syncMcpServerTools(
      userId,
      params.serverId,
    );

    return NextResponse.json({ ...server, toolsProblem });
  } catch (error) {
    if (error instanceof AgentSettingsError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    console.error("[agent] failed to read mcp tools", error);
    return NextResponse.json(
      { error: "Could not read that server's tools. Check the server log." },
      { status: 500 },
    );
  }
}
