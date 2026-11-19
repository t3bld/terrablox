import { NextResponse } from "next/server";

import { requireUserWithLimit } from "@/lib/api/guard";
import { RATE_LIMITS } from "@/lib/api/rate-limit";
import { routeError } from "@/lib/api/route-error";
import { database } from "@/lib/database";

/** Deletes only an unclaimed upload owned by the signed-in user. */
export async function DELETE(
  _request: Request,
  { params }: { params: { documentId: string } },
) {
  try {
    const userId = await requireUserWithLimit(
      "context-document.cancel",
      RATE_LIMITS.write,
    );
    await database.projectContextDocument.deleteMany({
      where: { id: params.documentId, userId, projectId: null },
    });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return routeError("context-document.cancel", error);
  }
}
