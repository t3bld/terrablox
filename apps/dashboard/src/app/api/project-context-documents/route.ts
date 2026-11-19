import { NextResponse } from "next/server";

import { requireUserWithLimit } from "@/lib/api/guard";
import { RATE_LIMITS } from "@/lib/api/rate-limit";
import { routeError } from "@/lib/api/route-error";
import {
  ContextDocumentError,
  contextDocumentDto,
  contextDocumentFile,
  createPendingContextDocument,
  parseContextDocument,
} from "@/lib/projects/context-documents";

export const runtime = "nodejs";

/** Stages one document while the import-project dialog has no project id yet. */
export async function POST(request: Request) {
  try {
    const userId = await requireUserWithLimit(
      "context-document.stage",
      RATE_LIMITS.write,
    );
    const parsed = await parseContextDocument(
      await contextDocumentFile(request),
    );
    const document = await createPendingContextDocument(userId, parsed);

    return NextResponse.json(
      { document: contextDocumentDto(document) },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof ContextDocumentError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }
    return routeError("context-document.stage", error);
  }
}
