import { NextResponse } from "next/server";
import { z } from "zod";
import { actOnRun, readRun } from "@/lib/agent-runs/service";
import { parseJsonBody, requireUserWithLimit } from "@/lib/api/guard";
import { RATE_LIMITS } from "@/lib/api/rate-limit";
import { routeError } from "@/lib/api/route-error";
import {
  getCurrentUserId,
  getUserGithubToken,
} from "@/lib/auth/server-helpers";
import { findOwnedProject } from "@/lib/projects/service";

/** Buttons only: Agent mode takes no free text. */
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve") }),
  z.object({ action: z.literal("retry") }),
  z.object({ action: z.literal("stop") }),
  z.object({ action: z.literal("resume") }),
]);

type Params = { params: { projectId: string; runId: string } };

/** One run in full, polled by the Agent tab while it works. */
export async function GET(_req: Request, { params }: Params) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const run = await readRun(userId, params.projectId, params.runId);
    return NextResponse.json({ run });
  } catch (e) {
    return routeError("agent-run", e);
  }
}

/** Everything the user can do to a run: approve, retry, stop, resume. */
export async function POST(req: Request, { params }: Params) {
  try {
    const userId = await requireUserWithLimit(
      "agent.run",
      RATE_LIMITS.agentTurn,
    );

    const project = await findOwnedProject(userId, params.projectId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const action = await parseJsonBody(req, actionSchema);

    // The runner reads the token itself; checked here so a missing link is an
    // answer to the click rather than a failed run a moment later.
    if (!(await getUserGithubToken())) {
      return NextResponse.json(
        { error: "Link your GitHub account to use the agent" },
        { status: 401 },
      );
    }

    const run = await actOnRun(userId, project.id, params.runId, action);
    return NextResponse.json({ run });
  } catch (e) {
    return routeError("agent-run", e);
  }
}
