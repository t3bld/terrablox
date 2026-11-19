import { NextResponse } from "next/server";

import { requireUserId, requireUserWithLimit } from "@/lib/api/guard";
import { RATE_LIMITS } from "@/lib/api/rate-limit";
import { routeError } from "@/lib/api/route-error";
import { database } from "@/lib/database";

async function ownedDocument(userId: string, projectId: string, id: string) {
  return database.projectContextDocument.findFirst({
    where: { id, projectId, userId },
  });
}

/** Downloads the retained original, never the extracted text. */
export async function GET(
  _request: Request,
  { params }: { params: { projectId: string; documentId: string } },
) {
  try {
    const userId = await requireUserId({ action: "context-document.download" });
    const document = await ownedDocument(
      userId,
      params.projectId,
      params.documentId,
    );
    if (!document) {
      return NextResponse.json(
        { error: "Document not found" },
        { status: 404 },
      );
    }

    const encoded = encodeURIComponent(document.originalName);
    return new NextResponse(new Uint8Array(document.content), {
      headers: {
        "Content-Type": document.mediaType,
        "Content-Length": String(document.byteSize),
        "Content-Disposition": `attachment; filename*=UTF-8''${encoded}`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return routeError("context-document.download", error);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: { projectId: string; documentId: string } },
) {
  try {
    const userId = await requireUserWithLimit(
      "context-document.delete",
      RATE_LIMITS.write,
    );
    const result = await database.projectContextDocument.deleteMany({
      where: {
        id: params.documentId,
        projectId: params.projectId,
        userId,
      },
    });
    if (result.count === 0) {
      return NextResponse.json(
        { error: "Document not found" },
        { status: 404 },
      );
    }
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return routeError("context-document.delete", error);
  }
}
