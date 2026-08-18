import { NextResponse } from "next/server";

import { getCurrentUserId } from "@/lib/auth/server-helpers";
import { database } from "@/lib/database";
import { hasInfracostApiKey } from "@/lib/integrations/infracost";

/**
 * Which of the user's own accounts are connected.
 *
 * One endpoint rather than one per integration, because the caller is a screen
 * that has to decide what it may show at all — asking twice would let it render
 * half a decision.
 */
export async function GET() {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [connections, infracost] = await Promise.all([
    database.awsConnection.findMany({
      where: { userId },
      select: { verifiedAt: true },
    }),
    hasInfracostApiKey(userId),
  ]);

  return NextResponse.json({
    aws: {
      connected: connections.length > 0,
      // A role that has never been assumed successfully is a promise, not a
      // connection, so the UI can warn without blocking.
      verified: connections.some(
        (connection) => connection.verifiedAt !== null,
      ),
    },
    infracost: { connected: infracost },
  });
}
