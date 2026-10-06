import { NextResponse } from "next/server";

import { requireUserWithLimit } from "@/lib/api/guard";
import { RATE_LIMITS } from "@/lib/api/rate-limit";
import { notFound, routeError } from "@/lib/api/route-error";
import { audit } from "@/lib/audit/log";
import { deleteConnection } from "@/lib/aws/connection-service";

export async function DELETE(
  _req: Request,
  { params }: { params: { connectionId: string } },
) {
  try {
    const userId = await requireUserWithLimit(
      "aws.connections.write",
      RATE_LIMITS.infrastructure,
    );

    // Scoped to the caller inside the service: `where: { id, userId }`, so another
    // user's connection id matches nothing rather than being deleted.
    const removed = await deleteConnection(userId, params.connectionId);
    if (!removed) return notFound();

    // Losing the ability to reach an account is worth a row for the same reason
    // gaining it is: it explains a later "no connected account" without guesswork.
    await audit({
      action: "aws.connection.deleted",
      userId,
      subject: params.connectionId,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return routeError("aws.connections.write", error);
  }
}
