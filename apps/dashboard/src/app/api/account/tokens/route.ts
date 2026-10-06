import { NextResponse } from "next/server";
import { z } from "zod";

import {
  parseJsonBody,
  requireUserId,
  requireUserWithLimit,
} from "@/lib/api/guard";
import { routeError } from "@/lib/api/route-error";
import {
  ApiTokenError,
  createApiToken,
  listApiTokens,
} from "@/lib/auth/api-token-service";

/**
 * Personal access tokens, for the settings screen.
 *
 * Cookie-authenticated only, and that is not an oversight: a token that could mint
 * another token would turn one leak into a permanent foothold, since the new one would
 * outlive the revocation of the first. `requireUserId` reads the session and nothing
 * else, so `requireCaller` — which would also accept a bearer token — is deliberately
 * not used here.
 */

export async function GET() {
  try {
    const userId = await requireUserId({ action: "account.tokens.list" });
    return NextResponse.json({ tokens: await listApiTokens(userId) });
  } catch (error) {
    return routeError("account.tokens.list", error);
  }
}

export async function POST(request: Request) {
  try {
    const userId = await requireUserWithLimit("account.tokens.create");

    const body = await parseJsonBody(
      request,
      z.object({
        name: z.string().trim().min(1, "Give the token a name.").max(100),
        // Read-only by default. A token is pasted into a config file, and the common
        // case — letting an agent look at a project — needs nothing more.
        scopes: z.array(z.enum(["read", "write"])).default(["read"]),
        expiresInDays: z.number().int().min(1).max(365).optional(),
      }),
    );

    const created = await createApiToken(userId, {
      name: body.name,
      scopes: body.scopes,
      ...(body.expiresInDays !== undefined
        ? { expiresInDays: body.expiresInDays }
        : {}),
    });

    // The plaintext is in this response and nowhere else, ever again.
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    if (error instanceof ApiTokenError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return routeError("account.tokens.create", error);
  }
}
