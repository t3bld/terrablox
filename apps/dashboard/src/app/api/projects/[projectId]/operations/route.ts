import { NextResponse } from "next/server";

import { getCurrentUserId } from "@/lib/auth/server-helpers";
import { database } from "@/lib/database";
import { findOwnedProject } from "@/lib/projects/service";
import type { ProjectOperationDto } from "@/lib/projects/types";

/** Enough to scroll through a working session without paging the whole history. */
const LIMIT = 100;

/**
 * Every edit applied to this project, newest first.
 *
 * Read from the operation log rather than from the repository's commit list:
 * the log knows which commits this app caused and who asked for them, which a
 * commit history cannot tell apart from a hand-written push.
 */
export async function GET(
  _request: Request,
  { params }: { params: { projectId: string } },
) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const project = await findOwnedProject(userId, params.projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  let operations: Awaited<
    ReturnType<typeof database.projectOperation.findMany>
  >;

  try {
    operations = await database.projectOperation.findMany({
      where: { projectId: project.id },
      orderBy: { createdAt: "desc" },
      take: LIMIT,
    });
  } catch (error) {
    console.error("[projects] failed to read operations", error);
    return NextResponse.json(
      {
        error:
          "Could not read the operation log. If this is a fresh checkout, run the pending database migrations.",
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    operations: operations.map(
      (entry): ProjectOperationDto => ({
        id: entry.id,
        origin: entry.origin === "agent" ? "agent" : "canvas",
        action: actionOf(entry.mutation),
        summary: entry.summary,
        commitSha: entry.commitSha,
        parentSha: entry.parentSha,
        createdAt: entry.createdAt.toISOString(),
      }),
    ),
    repoFullName: project.repoFullName,
  });
}

function actionOf(mutation: unknown): string {
  if (mutation && typeof mutation === "object" && !Array.isArray(mutation)) {
    const action = (mutation as { action?: unknown }).action;
    if (typeof action === "string") return action;
  }
  return "unknown";
}
