import "server-only";

import type {
  AgentRun,
  AgentRunEvent,
  AgentRunTask,
  Prisma,
} from "@terrablox/database";
import { database } from "@/lib/database";
import type { AgentStep } from "@/lib/projects/types";
import { missionTitle } from "./missions";
import {
  type AgentRunAutonomy,
  type AgentRunDto,
  type AgentRunEventDto,
  type AgentRunEventKind,
  type AgentRunPhase,
  type AgentRunStatus,
  type AgentRunSummaryDto,
  type AgentRunTaskDto,
  type AgentRunTaskStatus,
  FINISHED_STATUSES,
} from "./types";

/**
 * How recent a heartbeat must be for a run to count as being worked on.
 *
 * The runner beats every few seconds while an iteration is in flight. A run that
 * says it is working but has not beaten for this long belongs to a process that
 * is gone, and the Agent tab offers to resume it.
 */
export const HEARTBEAT_STALE_MS = 45_000;

export function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

export function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export async function addEvent(
  runId: string,
  kind: AgentRunEventKind,
  title: string,
  extra: { body?: string | null; data?: unknown; taskId?: string | null } = {},
): Promise<void> {
  await database.agentRunEvent
    .create({
      data: {
        runId,
        kind,
        title: title.slice(0, 300),
        body: extra.body ?? null,
        data: json(extra.data ?? {}),
        taskId: extra.taskId ?? null,
      },
    })
    // The timeline is a record of the run, never a reason for it to fail.
    .catch(() => {});
}

export async function setStatus(
  runId: string,
  status: AgentRunStatus,
  extra: Prisma.AgentRunUpdateInput = {},
): Promise<void> {
  await database.agentRun.update({
    where: { id: runId },
    data: {
      status,
      ...(FINISHED_STATUSES.includes(status) ? { finishedAt: new Date() } : {}),
      ...extra,
    },
  });
}

export function isLive(run: Pick<AgentRun, "heartbeatAt">): boolean {
  return (
    run.heartbeatAt !== null &&
    Date.now() - run.heartbeatAt.getTime() < HEARTBEAT_STALE_MS
  );
}

function toTaskDto(task: AgentRunTask): AgentRunTaskDto {
  return {
    id: task.id,
    key: task.key,
    position: task.position,
    phase: task.phase as AgentRunPhase,
    title: task.title,
    detail: task.detail,
    dependsOn: strings(task.dependsOn),
    status: task.status as AgentRunTaskStatus,
    attempts: task.attempts,
    summary: task.summary,
    startedAt: task.startedAt?.toISOString() ?? null,
    finishedAt: task.finishedAt?.toISOString() ?? null,
  };
}

function toEventDto(event: AgentRunEvent): AgentRunEventDto {
  return {
    id: event.id,
    taskId: event.taskId,
    kind: event.kind as AgentRunEventKind,
    title: event.title,
    body: event.body,
    data:
      event.data && typeof event.data === "object" && !Array.isArray(event.data)
        ? (event.data as Record<string, unknown>)
        : {},
    createdAt: event.createdAt.toISOString(),
  };
}

function readSteps(value: unknown): AgentStep[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is AgentStep => {
    if (!entry || typeof entry !== "object") return false;
    const step = entry as Record<string, unknown>;
    if (step.kind === "thought") return typeof step.text === "string";
    return (
      step.kind === "tool" &&
      typeof step.tool === "string" &&
      typeof step.summary === "string"
    );
  });
}

export function toSummaryDto(
  run: AgentRun & { tasks: Pick<AgentRunTask, "status">[] },
): AgentRunSummaryDto {
  return {
    id: run.id,
    mission: run.mission,
    title: missionTitle(run.mission),
    status: run.status as AgentRunStatus,
    autonomy: run.autonomy as AgentRunAutonomy,
    tasksDone: run.tasks.filter(
      (task) => task.status === "done" || task.status === "skipped",
    ).length,
    tasksTotal: run.tasks.length,
    prUrl: run.prUrl,
    createdAt: run.createdAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}

export function toRunDto(
  run: AgentRun & { tasks: AgentRunTask[]; events: AgentRunEvent[] },
  repoFullName: string,
): AgentRunDto {
  const encodedBranch = run.branch.split("/").map(encodeURIComponent).join("/");

  return {
    ...toSummaryDto(run),
    planSummary: run.planSummary,
    assumptions: strings(run.assumptions),
    baseBranch: run.baseBranch,
    branch: run.branch,
    branchUrl: `https://github.com/${repoFullName}/tree/${encodedBranch}`,
    commitsUrl: `https://github.com/${repoFullName}/commits/${encodedBranch}`,
    iterations: run.iterations,
    maxIterations: run.maxIterations,
    commits: strings(run.commits),
    question: run.question,
    pendingGuidance: strings(run.pendingGuidance),
    liveSteps: readSteps(run.liveSteps),
    prNumber: run.prNumber,
    outcome: run.outcome,
    error: run.error,
    startedAt: run.startedAt.toISOString(),
    live: isLive(run),
    tasks: [...run.tasks]
      .sort((a, b) => a.position - b.position)
      .map(toTaskDto),
    events: [...run.events]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(toEventDto),
  };
}

/** A run of this user's on this project, with everything the Agent tab draws. */
export async function findOwnedRun(
  userId: string,
  projectId: string,
  runId: string,
) {
  return database.agentRun.findFirst({
    where: { id: runId, userId, projectId },
    include: {
      tasks: true,
      events: { orderBy: { createdAt: "asc" }, take: 500 },
      project: { select: { repoFullName: true } },
    },
  });
}
