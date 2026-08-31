import { NextResponse } from "next/server";

import { AgentSettingsError, addMcpServer } from "@/lib/agent/settings-service";
import { getCurrentUserId } from "@/lib/auth/server-helpers";

/** Adds a remote MCP server for the signed-in user. Disabled until they say so. */
export async function POST(request: Request) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    name?: unknown;
    url?: unknown;
    transport?: unknown;
    headers?: unknown;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
  }

  if (typeof body.name !== "string" || typeof body.url !== "string") {
    return NextResponse.json(
      { error: "A name and a URL are required." },
      { status: 400 },
    );
  }

  const headers: Record<string, string> = {};

  if (body.headers && typeof body.headers === "object") {
    for (const [key, value] of Object.entries(
      body.headers as Record<string, unknown>,
    )) {
      if (typeof value === "string") headers[key] = value;
    }
  }

  try {
    const { server, toolsProblem } = await addMcpServer(userId, {
      name: body.name,
      url: body.url,
      transport: typeof body.transport === "string" ? body.transport : "http",
      headers,
    });

    // 201 even when the tool fetch failed: the server *was* added, and the client
    // has to be able to tell "nothing was stored" from "stored, but its catalogue
    // could not be read" — the second is fixed with a Refresh, not a re-add.
    return NextResponse.json({ ...server, toolsProblem }, { status: 201 });
  } catch (error) {
    if (error instanceof AgentSettingsError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    console.error("[agent] failed to add mcp server", error);
    return NextResponse.json(
      { error: "Could not add that server. Check the server log." },
      { status: 500 },
    );
  }
}
