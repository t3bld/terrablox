import { NextResponse } from "next/server";

import { getCurrentUserId } from "@/lib/auth/server-helpers";
import { database } from "@/lib/database";
import type { AgentStep } from "@/lib/projects/types";

/**
 * What the agent is doing for this project right now.
 *
 * The chat panel polls this on mount and while the agent is running, so a user
 * who navigated away and came back sees the spinner rather than a silent panel.
 *
 * It also carries the steps recorded so far. A turn that builds a stack can run
 * for minutes, and the only thing to show used to be "the agent is working" —
 * which after two silent minutes reads as a hang. The trail lives on the project
 * row because the assistant message it eventually belongs to does not exist yet.
 */
export async function GET(
  _req: Request,
  { params }: { params: { projectId: string } },
) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const project = await database.project.findFirst({
    where: { id: params.projectId, userId },
    select: { agentRunning: true, agentSteps: true },
  });

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  return NextResponse.json({
    running: project.agentRunning,
    steps: readLiveSteps(project.agentSteps),
  });
}

/**
 * The column is untyped JSON, so it is validated rather than trusted — a shape
 * change in `AgentStep` would otherwise reach the client as a broken render.
 */
function readLiveSteps(value: unknown): AgentStep[] {
  if (!Array.isArray(value)) return [];

  return value.filter((entry): entry is AgentStep => {
    if (!entry || typeof entry !== "object") return false;
    const step = entry as Record<string, unknown>;

    if (step.kind === "thought") return typeof step.text === "string";
    if (step.kind === "tool") {
      return typeof step.tool === "string" && typeof step.summary === "string";
    }
    return false;
  });
}
