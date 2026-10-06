import { NextResponse } from "next/server";
import { z } from "zod";

import {
  AgentSettingsError,
  deleteMcpServer,
  setMcpServerDisabledTools,
  setMcpServerEnabled,
} from "@/lib/agent/settings-service";
import { parseJsonBody, requireUserWithLimit } from "@/lib/api/guard";
import { badRequest, routeError } from "@/lib/api/route-error";
import { audit } from "@/lib/audit/log";

/**
 * One field or the other, and at least one.
 *
 * `.refine` rather than two endpoints because they are the same resource and a caller
 * sends whichever it changed. Each is optional so switching a tool cannot silently
 * switch the server, and the refine is what keeps an empty body from being a no-op
 * that reports success.
 */
const patchBody = z
  .object({
    enabled: z.boolean().optional(),
    disabledTools: z
      .array(z.string().trim().min(1).max(200))
      .max(500, "That is more tools than a server has")
      .optional(),
  })
  .refine((value) => value.enabled !== undefined || value.disabledTools, {
    message: "Send `enabled` or `disabledTools`.",
  });

/**
 * Changes one server: the whole thing on or off, or which of its tools are on.
 *
 * Ownership is enforced in the service, which scopes every write with
 * `where: { id, userId }` — so a server id belonging to somebody else simply matches
 * nothing rather than being changed.
 */
export async function PATCH(
  request: Request,
  { params }: { params: { serverId: string } },
) {
  try {
    const userId = await requireUserWithLimit("agent.mcp.write");

    const body = await parseJsonBody(request, patchBody);

    if (body.disabledTools) {
      await setMcpServerDisabledTools(
        userId,
        params.serverId,
        body.disabledTools,
      );
    }

    if (body.enabled !== undefined) {
      await setMcpServerEnabled(userId, params.serverId, body.enabled);
    }

    // Enabling a server is the point at which the agent may start calling it with
    // the stored credential, which is what makes this worth recording.
    await audit({
      action: "mcp.server.updated",
      userId,
      subject: params.serverId,
      detail: {
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.disabledTools
          ? { disabledToolCount: body.disabledTools.length }
          : {}),
      },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof AgentSettingsError) {
      return badRequest(error.message);
    }
    return routeError("agent.mcp.write", error);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: { serverId: string } },
) {
  try {
    const userId = await requireUserWithLimit("agent.mcp.write");

    await deleteMcpServer(userId, params.serverId);

    await audit({
      action: "mcp.server.deleted",
      userId,
      subject: params.serverId,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return routeError("agent.mcp.write", error);
  }
}
