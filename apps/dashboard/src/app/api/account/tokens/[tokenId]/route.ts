import { NextResponse } from "next/server";

import { requireUserWithLimit } from "@/lib/api/guard";
import { routeError } from "@/lib/api/route-error";
import { revokeApiToken } from "@/lib/auth/api-token-service";

/**
 * Revokes a token.
 *
 * Cookie-only, like its sibling: a leaked token must not be able to revoke the others
 * and leave itself the only way in.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: { tokenId: string } },
) {
  try {
    const userId = await requireUserWithLimit("account.tokens.revoke");

    const revoked = await revokeApiToken(userId, params.tokenId);
    if (!revoked) {
      // 404 rather than 403 for somebody else's token, the same way project lookups
      // do it: the answer must not confirm that an id exists.
      return NextResponse.json({ error: "Token not found" }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return routeError("account.tokens.revoke", error);
  }
}
