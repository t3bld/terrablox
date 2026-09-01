import { NextResponse } from "next/server";

import { getCurrentUserId } from "@/lib/auth/server-helpers";
import { readProjectLog } from "@/lib/projects/decisions";
import { findOwnedProject } from "@/lib/projects/service";

/**
 * The project's log: what was decided, why, and which edits carried it out.
 *
 * A sibling of `operations` rather than a replacement for it. That route answers
 * "what changed, when" as a flat list and is the raw index into the repository;
 * this one groups the same rows under the decision they belong to and adds the
 * reason, which is the question a reader actually arrives with.
 */
export async function GET(
  _req: Request,
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

  try {
    return NextResponse.json({
      log: await readProjectLog(project.id),
      repoFullName: project.repoFullName,
    });
  } catch {
    // The tables are recent enough that a database behind on migrations is the
    // likeliest cause, and "log unavailable" would send somebody looking at the
    // wrong thing.
    return NextResponse.json(
      {
        error:
          "Could not read the log. If this instance was just updated, apply the database migrations.",
      },
      { status: 500 },
    );
  }
}
