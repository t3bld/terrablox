import { NextResponse } from "next/server";

import { getCurrentUserId } from "@/lib/auth/server-helpers";
import { database } from "@/lib/database";
import { findOwnedProject } from "@/lib/projects/service";

/**
 * Stores node positions.
 *
 * Layout is presentation, not configuration, so it is kept in the database
 * rather than committed: dragging a node must not produce a commit.
 */
export async function PUT(
  req: Request,
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

  const body = (await req.json().catch(() => null)) as {
    positions?: Record<string, { x?: unknown; y?: unknown }>;
  } | null;

  if (!body?.positions || typeof body.positions !== "object") {
    return NextResponse.json({ error: "Missing positions" }, { status: 400 });
  }

  const positions: Record<string, { x: number; y: number }> = {};
  for (const [id, value] of Object.entries(body.positions)) {
    if (typeof value?.x === "number" && typeof value?.y === "number") {
      positions[id] = { x: value.x, y: value.y };
    }
  }

  await database.project.update({
    where: { id: project.id },
    data: { graphPositions: positions },
  });

  return NextResponse.json({ ok: true });
}
