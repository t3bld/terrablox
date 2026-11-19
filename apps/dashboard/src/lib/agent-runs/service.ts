import "server-only";

import type { Project } from "@terrablox/database";
import { getBranchHead } from "@terrablox/git/files";
import { ApiError } from "@/lib/api/route-error";
import { database } from "@/lib/database";
import { findMission, missionUnavailable } from "./missions";
import { RUN_STEP_CEILING } from "./plan";
import { ensureRunner } from "./runner";
import {
  addEvent,
  findOwnedRun,
  isLive,
  setStatus,
  toRunDto,
  toSummaryDto,
} from "./store";
import {
  type AgentRunAction,
  type AgentRunAutonomy,
  type AgentRunDto,
  type AgentRunSources,
  type AgentRunStatus,
  type AgentRunSummaryDto,
  FINISHED_STATUSES,
  WORKING_STATUSES,
} from "./types";

/** Thrown for anything the user can fix; `routeError` passes the message on. */
export class AgentRunError extends ApiError {
  constructor(message: string, status = 409) {
    super(message, status);
    this.name = "AgentRunError";
  }
}

export async function listRuns(
  projectId: string,
  userId: string,
): Promise<AgentRunSummaryDto[]> {
  const runs = await database.agentRun.findMany({
    where: { projectId, userId },
    orderBy: { createdAt: "desc" },
    take: 30,
    include: { tasks: { select: { status: true } } },
  });
  return runs.map(toSummaryDto);
}

export async function readSources(
  project: Project,
  userId: string,
): Promise<AgentRunSources> {
  const [documentCount, mcpServerCount] = await Promise.all([
    database.projectContextDocument.count({
      where: { projectId: project.id, userId },
    }),
    database.agentMcpServer.count({ where: { userId, enabled: true } }),
  ]);

  return {
    repoFullName: project.repoFullName,
    repoBranch: project.repoBranch,
    appRepoFullName: project.appRepoFullName,
    documentCount,
    mcpServerCount,
    awsConnected: Boolean(project.awsAccountId),
  };
}

/**
 * Starts a mission and hands the run to a runner.
 *
 * The agent commits straight to the project branch, like the chat does. One open
 * run per project, so two missions never edit the same Terraform at once.
 */
export async function startRun(params: {
  project: Project;
  userId: string;
  token: string;
  missionId: string;
  autonomy: AgentRunAutonomy;
}): Promise<AgentRunDto> {
  const { project, userId, token } = params;

  const mission = findMission(params.missionId);
  if (!mission) throw new AgentRunError("Unknown mission.", 400);

  const documentCount = await database.projectContextDocument.count({
    where: { projectId: project.id, userId },
  });
  const unavailable = missionUnavailable(mission, {
    appRepoFullName: project.appRepoFullName,
    documentCount,
  });
  if (unavailable) throw new AgentRunError(unavailable, 400);

  const open = await database.agentRun.findFirst({
    where: {
      projectId: project.id,
      status: { notIn: [...FINISHED_STATUSES] },
    },
    select: { id: true },
  });
  if (open) {
    throw new AgentRunError(
      "This project already has a mission in progress. Finish or stop it before starting another.",
    );
  }

  const baseSha = await getBranchHead(token, {
    repoFullName: project.repoFullName,
    branch: project.repoBranch,
  });
  if (!baseSha) {
    throw new AgentRunError(
      `The branch ${project.repoBranch} has no commits yet, so there is nothing to branch from.`,
    );
  }

  const run = await database.agentRun.create({
    data: {
      projectId: project.id,
      userId,
      mission: mission.mission,
      autonomy: params.autonomy,
      status: "planning",
      baseBranch: project.repoBranch,
      baseSha,
      branch: project.repoBranch,
      maxIterations: RUN_STEP_CEILING,
    },
  });

  await addEvent(run.id, "status", "Mission started", {
    body: `Working directly on ${project.repoBranch}, starting from ${baseSha.slice(0, 7)}.`,
    data: { status: "planning" },
  });

  await ensureRunner(run.id);
  return readRun(userId, project.id, run.id);
}

/**
 * A run as the Agent tab draws it.
 *
 * Also where a run orphaned by a restart is noticed: it claims to be working but
 * nobody has beaten its heart for a while. It is paused rather than silently
 * resumed, so a restart never spends the user's quota without them asking.
 */
export async function readRun(
  userId: string,
  projectId: string,
  runId: string,
): Promise<AgentRunDto> {
  const run = await findOwnedRun(userId, projectId, runId);
  if (!run) throw new AgentRunError("Run not found", 404);

  if (
    WORKING_STATUSES.includes(run.status as AgentRunStatus) &&
    !isLive(run) &&
    Date.now() - run.updatedAt.getTime() > 60_000
  ) {
    await setStatus(run.id, "paused", {
      question:
        "The server restarted while the agent was working. Resume to continue where it left off.",
    });
    await addEvent(run.id, "status", "Paused after a server restart", {
      data: { status: "paused" },
    });
    const refreshed = await findOwnedRun(userId, projectId, runId);
    if (refreshed) return toRunDto(refreshed, refreshed.project.repoFullName);
  }

  return toRunDto(run, run.project.repoFullName);
}

/**
 * A fresh allowance when the user sends a run back to work.
 *
 * Retrying resets failed tasks' attempts, so the run may legitimately need more
 * turns than it had left.
 */
function headroom(run: { iterations: number; maxIterations: number }): number {
  return Math.max(run.maxIterations, run.iterations + RUN_STEP_CEILING);
}

export async function actOnRun(
  userId: string,
  projectId: string,
  runId: string,
  action: AgentRunAction,
): Promise<AgentRunDto> {
  const run = await findOwnedRun(userId, projectId, runId);
  if (!run) throw new AgentRunError("Run not found", 404);
  const status = run.status as AgentRunStatus;

  const requireStatus = (...allowed: AgentRunStatus[]) => {
    if (!allowed.includes(status)) {
      throw new AgentRunError(
        `That is not possible while the run is ${status.replace("_", " ")}.`,
      );
    }
  };

  switch (action.action) {
    case "approve": {
      requireStatus("awaiting_approval");
      await setStatus(run.id, "running", { question: null });
      await addEvent(run.id, "approval", "You approved the plan");
      await ensureRunner(run.id);
      break;
    }
    case "retry": {
      requireStatus("awaiting_input");
      // Failed tasks get another go; a run that never produced a plan plans again.
      await database.agentRunTask.updateMany({
        where: { runId: run.id, status: "failed" },
        data: { status: "pending", attempts: 0, finishedAt: null },
      });
      await setStatus(run.id, run.tasks.length ? "running" : "planning", {
        question: null,
        maxIterations: headroom(run),
      });
      await addEvent(run.id, "status", "You asked the agent to try again", {
        data: { status: "running" },
      });
      await ensureRunner(run.id);
      break;
    }
    case "stop": {
      if (FINISHED_STATUSES.includes(status)) break;
      await setStatus(run.id, "stopped", { question: null });
      await database.agentRunTask.updateMany({
        where: { runId: run.id, status: "in_progress" },
        data: { status: "pending" },
      });
      await addEvent(run.id, "status", "You stopped the run", {
        body: `Edits from the step in progress were dropped. Everything committed before stays on ${run.baseBranch}.`,
        data: { status: "stopped" },
      });
      break;
    }
    case "resume": {
      requireStatus("paused", "failed", "stopped");
      await setStatus(run.id, run.tasks.length ? "running" : "planning", {
        question: null,
        error: null,
        finishedAt: null,
        maxIterations: headroom(run),
      });
      await addEvent(run.id, "status", "You resumed the run", {
        data: { status: "running" },
      });
      await ensureRunner(run.id);
      break;
    }
  }

  return readRun(userId, projectId, runId);
}
