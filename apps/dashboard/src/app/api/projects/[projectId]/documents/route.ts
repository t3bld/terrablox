import { NextResponse } from "next/server";

import { requireUserId, requireUserWithLimit } from "@/lib/api/guard";
import { RATE_LIMITS } from "@/lib/api/rate-limit";
import { routeError } from "@/lib/api/route-error";
import { database } from "@/lib/database";
import {
  ContextDocumentError,
  contextDocumentDto,
  contextDocumentFile,
  createProjectContextDocument,
  parseContextDocument,
} from "@/lib/projects/context-documents";
import { findOwnedProject } from "@/lib/projects/service";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: { projectId: string } },
) {
  try {
    const userId = await requireUserId({ action: "context-documents.list" });
    const project = await findOwnedProject(userId, params.projectId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const documents = await database.projectContextDocument.findMany({
      where: { projectId: project.id },
      orderBy: { createdAt: "asc" },
    });
    return NextResponse.json({
      documents: documents.map(contextDocumentDto),
    });
  } catch (error) {
    return routeError("context-documents.list", error);
  }
}

export async function POST(
  request: Request,
  { params }: { params: { projectId: string } },
) {
  try {
    const userId = await requireUserWithLimit(
      "context-document.upload",
      RATE_LIMITS.write,
    );
    const project = await findOwnedProject(userId, params.projectId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const parsed = await parseContextDocument(
      await contextDocumentFile(request),
    );
    const document = await createProjectContextDocument(
      userId,
      project.id,
      parsed,
    );
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
    return routeError("context-document.upload", error);
  }
}
