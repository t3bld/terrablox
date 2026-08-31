import { NextResponse } from "next/server";

import {
  AgentSettingsError,
  deleteMcpServer,
  setMcpServerDisabledTools,
  setMcpServerEnabled,
} from "@/lib/agent/settings-service";
import { getCurrentUserId } from "@/lib/auth/server-helpers";

/**
 * Changes one server: the whole thing on or off, or which of its tools are on.
 *
 * One handler for two fields rather than two endpoints, because they are the same
 * resource and a caller sends whichever it changed. Each is read only when
 * present, so switching a tool cannot silently switch the server.
 */
export async function PATCH(
  request: Request,
  { params }: { params: { serverId: string } },
) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { enabled?: unknown; disabledTools?: unknown };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
  }

  const wantsEnabled = "enabled" in body;
  const wantsTools = "disabledTools" in body;

  if (!wantsEnabled && !wantsTools) {
    return NextResponse.json(
      { error: "Send `enabled` or `disabledTools`." },
      { status: 400 },
    );
  }

  if (wantsEnabled && typeof body.enabled !== "boolean") {
    return NextResponse.json(
      { error: "`enabled` must be true or false." },
      { status: 400 },
    );
  }

  if (
    wantsTools &&
    (!Array.isArray(body.disabledTools) ||
      body.disabledTools.some((entry) => typeof entry !== "string"))
  ) {
    return NextResponse.json(
      { error: "`disabledTools` must be a list of tool names." },
      { status: 400 },
    );
  }

  try {
    if (wantsTools) {
      await setMcpServerDisabledTools(
        userId,
        params.serverId,
        body.disabledTools as string[],
      );
    }

    if (wantsEnabled) {
      await setMcpServerEnabled(
        userId,
        params.serverId,
        body.enabled as boolean,
      );
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof AgentSettingsError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    console.error("[agent] failed to change mcp server", error);
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
