import { NextResponse } from "next/server";

import { requireUserWithLimit } from "@/lib/api/guard";
import { RATE_LIMITS } from "@/lib/api/rate-limit";
import { notFound, routeError } from "@/lib/api/route-error";
import { audit } from "@/lib/audit/log";
import { verifyConnection } from "@/lib/aws/connection-service";

/**
 * Proves the connection works by using it once.
 *
 * A failed assume is not a server error: it usually means the trust policy is
 * not written yet, so the result is stored on the connection and returned with
 * 200 for the UI to explain.
 *
 * Rate limited on the infrastructure budget because each call performs a real
 * `sts:AssumeRole` against a customer account — an unbounded loop here would be a
 * stream of failed-assume events in somebody else's CloudTrail.
 */
export async function POST(
  _req: Request,
  { params }: { params: { connectionId: string } },
) {
  try {
    const userId = await requireUserWithLimit(
      "aws.connections.verify",
      RATE_LIMITS.infrastructure,
    );

    const connection = await verifyConnection(userId, params.connectionId);
    if (!connection) return notFound();

    // The outcome, not just the attempt: this row is the answer to "when did this
    // connection last actually work", which the connection's own `verifiedAt` only
    // holds for the most recent success.
    await audit({
      action: "aws.connection.verified",
      userId,
      subject: connection.id,
      outcome: connection.verifiedAt ? "ok" : "error",
      detail: {
        accountId: connection.accountId,
        ...(connection.lastError ? { error: connection.lastError } : {}),
      },
    });

    return NextResponse.json({ connection });
  } catch (error) {
    return routeError("aws.connections.verify", error);
  }
}
