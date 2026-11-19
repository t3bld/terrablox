import { NextResponse } from "next/server";
import { z } from "zod";
import { AGENT_MISSIONS, type AgentMissionId } from "@/lib/agent-runs/missions";
import { listRuns, readSources, startRun } from "@/lib/agent-runs/service";
import { parseJsonBody, requireUserWithLimit } from "@/lib/api/guard";
import { RATE_LIMITS } from "@/lib/api/rate-limit";
import { routeError } from "@/lib/api/route-error";
import {
  getCurrentUserId,
  getUserGithubToken,
} from "@/lib/auth/server-helpers";
import { findOwnedProject } from "@/lib/projects/service";

/** The project's missions, newest first, and what a new one could read. */
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
    const [runs, sources] = await Promise.all([
      listRuns(project.id, userId),
      readSources(project, userId),
    ]);
    return NextResponse.json({ runs, sources });
  } catch (e) {
    return routeError("agent-runs", e);
  }
}

/** Starts a mission. Returns as soon as the run exists; the work is in the background. */
export async function POST(
  req: Request,
  { params }: { params: { projectId: string } },
) {
  try {
    const userId = await requireUserWithLimit(
      "agent.run",
      RATE_LIMITS.agentTurn,
    );

    const project = await findOwnedProject(userId, params.projectId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const body = await parseJsonBody(
      req,
      z.object({
        missionId: z.enum(
          AGENT_MISSIONS.map((entry) => entry.id) as [
            AgentMissionId,
            ...AgentMissionId[],
          ],
        ),
        autonomy: z.enum(["supervised", "autonomous"]).default("supervised"),
      }),
    );

    const token = await getUserGithubToken();
    if (!token) {
      return NextResponse.json(
        { error: "Link your GitHub account to use the agent" },
        { status: 401 },
      );
    }

    const run = await startRun({
      project,
      userId,
      token,
      missionId: body.missionId,
      autonomy: body.autonomy,
    });

    return NextResponse.json({ run }, { status: 201 });
  } catch (e) {
    return routeError("agent-runs", e);
  }
}
