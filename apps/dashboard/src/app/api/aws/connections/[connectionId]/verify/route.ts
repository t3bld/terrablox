import { NextResponse } from "next/server";

import { getCurrentUserId } from "@/lib/auth/server-helpers";
import { verifyConnection } from "@/lib/aws/connection-service";

/**
 * Proves the connection works by using it once.
 *
 * A failed assume is not a server error: it usually means the trust policy is
 * not written yet, so the result is stored on the connection and returned with
 * 200 for the UI to explain.
 */
export async function POST(
  _req: Request,
  { params }: { params: { connectionId: string } },
) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const connection = await verifyConnection(userId, params.connectionId);
  if (!connection) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ connection });
}
