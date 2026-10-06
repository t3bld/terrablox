import { NextResponse } from "next/server";
import { z } from "zod";

import { AgentSettingsError, addMcpServer } from "@/lib/agent/settings-service";
import { parseJsonBody, requireUserWithLimit } from "@/lib/api/guard";
import { badRequest, routeError } from "@/lib/api/route-error";
import * as schema from "@/lib/api/schemas";
import { audit } from "@/lib/audit/log";

/**
 * A new MCP server registration.
 *
 * The URL is *not* fully validated here — `addMcpServer` runs it through
 * `assertSafeUrl`, which rejects private addresses and non-https schemes, and that
 * check has to stay where it is because it also guards the re-validation path. What
 * this schema adds is shape and bounds: a string, a sane length, and a header map that
 * cannot grow without limit.
 *
 * `headers` used to be filtered rather than validated — non-string values were dropped
 * and the request accepted — so a client bug produced a server registered with half
 * its credentials and no error to explain the 401 that followed.
 */
const addBody = z.object({
  name: schema.displayText(80),
  url: z.string().trim().min(1).max(500),
  transport: z.enum(["http", "sse"]).optional().default("http"),
  headers: z
    .record(
      z.string().regex(/^[a-zA-Z0-9-]+$/, "That is not a valid header name"),
      z.string().max(4000),
    )
    .refine((value) => Object.keys(value).length <= 10, {
      message: "That is more headers than any server needs.",
    })
    .optional()
    .default({}),
});

/** Adds a remote MCP server for the signed-in user. Disabled until they say so. */
export async function POST(request: Request) {
  try {
    const userId = await requireUserWithLimit("agent.mcp.write");

    const body = await parseJsonBody(request, addBody);

    const { server, toolsProblem } = await addMcpServer(userId, {
      name: body.name,
      url: body.url,
      transport: body.transport,
      headers: body.headers,
    });

    // The header values are credentials for somebody else's system, so the row
    // records that a server was added and its URL — never the headers themselves.
    await audit({
      action: "mcp.server.created",
      userId,
      subject: server.id,
      detail: {
        name: body.name,
        url: server.url,
        headerNames: Object.keys(body.headers),
      },
    });

    // 201 even when the tool fetch failed: the server *was* added, and the client
    // has to be able to tell "nothing was stored" from "stored, but its catalogue
    // could not be read" — the second is fixed with a Refresh, not a re-add.
    return NextResponse.json({ ...server, toolsProblem }, { status: 201 });
  } catch (error) {
    if (error instanceof AgentSettingsError) {
      return badRequest(error.message);
    }
    return routeError("agent.mcp.write", error);
  }
}
