import { NextResponse } from "next/server";

import {
  AgentSettingsError,
  deleteMcpServer,
  setMcpServerEnabled,
} from "@/lib/agent/settings-service";
import { getCurrentUserId } from "@/lib/auth/server-helpers";

/** Turns one server on or off. Both directions are one click, deliberately. */
export async function PATCH(
  request: Request,
  { params }: { params: { serverId: string } },
) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { enabled?: unknown };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
  }

  if (typeof body.enabled !== "boolean") {
    return NextResponse.json(
      { error: "`enabled` must be true or false." },
      { status: 400 },
    );
  }

  try {
    await setMcpServerEnabled(userId, params.serverId, body.enabled);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof AgentSettingsError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    console.error("[agent] failed to toggle mcp server", error);
    return NextResponse.json(
      { error: "Could not change that server. Check the server log." },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: { serverId: string } },
) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await deleteMcpServer(userId, params.serverId);

  return NextResponse.json({ ok: true });
}
