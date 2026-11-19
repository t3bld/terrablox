import "server-only";

import { defineTool, type Tool } from "@github/copilot-sdk";
import type { AgentRun, AgentRunTask, Project } from "@terrablox/database";
import { runProjectAgent, TurnCancelled } from "@/lib/agent/project-agent";
import { githubTokenForUser } from "@/lib/auth/server-helpers";
import { database } from "@/lib/database";
import { recordDecision } from "@/lib/projects/decisions";
import { applyProjectMutation } from "@/lib/projects/service";
import type { AgentStep } from "@/lib/projects/types";
import { buildRunContext, readBranchCheck } from "./context";
import {
  type BriefTask,
  isPhase,
  MAX_PLANNING_ATTEMPTS,
  MAX_RUN_TASKS,
  MAX_TASK_ATTEMPTS,
  nextStep,
  planningBrief,
  type RawPlan,
  taskBrief,
  validatePlan,
} from "./plan";
import {
  addEvent,
  HEARTBEAT_STALE_MS,
  json,
  setStatus,
  strings,
} from "./store";
import type { AgentRunPhase, AgentRunTaskStatus } from "./types";

/**
 * The Agent mode loop.
 *
 * A run is a sequence of ordinary agent turns, one per iteration, each on a fresh
 * Copilot session. Between iterations everything lives in Postgres: the plan, the
 * task states, the summaries, the guidance. That is what lets a run outlive the
 * request that started it, be stopped from any process, and be resumed after a
 * restart without the model having to remember anything.
 *
 * Draft scope: the loop runs inside the dashboard process. Moving it to a worker
 * later only changes who calls `ensureRunner`, not what it does.
 */

const HEARTBEAT_INTERVAL_MS = 5_000;

const LIVE_STEPS_INTERVAL_MS = 1_500;

/** Runs this process is driving right now. */
const active = new Set<string>();
/** Runs whose runner should start again once the current one has exited. */
const rerun = new Set<string>();

/**
 * Starts driving a run in this process, unless something already is.
 *
 * Claiming is a conditional write on the heartbeat, so two processes asked to
 * resume the same run cannot both win.
 */
export async function ensureRunner(runId: string): Promise<boolean> {
  // A runner that is on its way out (it just paused for approval, say) would miss
  // the status change that brought us here, so it is asked to start again.
  if (active.has(runId)) {
    rerun.add(runId);
    return true;
  }

  const staleBefore = new Date(Date.now() - HEARTBEAT_STALE_MS);
  const claimed = await database.agentRun.updateMany({
    where: {
      id: runId,
      status: { in: ["planning", "running"] },
      OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: staleBefore } }],
    },
    data: { heartbeatAt: new Date() },
  });
  if (claimed.count === 0) return false;

  active.add(runId);
  void drive(runId).finally(() => {
    active.delete(runId);
    if (rerun.delete(runId)) void ensureRunner(runId).catch(() => {});
  });
  return true;
}

async function drive(runId: string): Promise<void> {
  const cancellation = new AbortController();

  // One timer for the whole run: proves it is alive (including while edits are
  // being committed, which can take longer than a turn) and notices a stop pressed
  // in another request, which can only reach this loop through the database.
  const beat = setInterval(() => {
    void database.agentRun
      .update({
        where: { id: runId },
        data: { heartbeatAt: new Date() },
        select: { status: true },
      })
      .then((row) => {
        if (row.status === "stopped") cancellation.abort();
      })
      .catch(() => {});
  }, HEARTBEAT_INTERVAL_MS);

  try {
    for (;;) {
      if (cancellation.signal.aborted) return;

      const run = await database.agentRun.findUnique({
        where: { id: runId },
        include: { tasks: true, project: true },
      });
      if (!run || (run.status !== "planning" && run.status !== "running")) {
        return;
      }

      if (run.iterations >= run.maxIterations) {
        await setStatus(runId, "paused", {
          question: `The run took ${run.maxIterations} steps without finishing, which should not happen. Resume to let it continue, or stop it and review the branch.`,
        });
        await addEvent(runId, "status", "Paused: unusually many steps", {
          data: { status: "paused" },
        });
        return;
      }

      const token = await githubTokenForUser(run.userId);
      if (!token) {
        await fail(
          runId,
          "GitHub is not connected for this account, so the run cannot read or write the repository.",
        );
        return;
      }

      const keepGoing =
        run.status === "planning"
          ? await planIteration(run, token, cancellation.signal)
          : await workIteration(run, token, cancellation.signal);

      if (!keepGoing) return;
    }
  } catch (error) {
    await fail(
      runId,
      error instanceof Error ? error.message : "The run stopped unexpectedly.",
    );
  } finally {
    clearInterval(beat);
    await database.agentRun
      .update({
        where: { id: runId },
        data: { heartbeatAt: null, liveSteps: json([]) },
      })
      .catch(() => {});
  }
}

type LoadedRun = AgentRun & { tasks: AgentRunTask[]; project: Project };

/** What the run-only tools reported during one iteration. */
interface IterationSignals {
  plan: ReturnType<typeof validatePlan> | null;
  completed: string | null;
  added: Array<{
    key: string;
    phase: AgentRunPhase;
    title: string;
    detail: string;
  }>;
}

function emptySignals(): IterationSignals {
  return { plan: null, completed: null, added: [] };
}

/**
 * The tools that only exist inside a run.
 *
 * They change nothing while the turn runs. Like the catalogue's tools they only
 * record what the agent said, and the loop acts on it once the turn is over.
 */
function runTools(
  signals: IterationSignals,
  mode: "plan" | "task",
  existingKeys: Set<string>,
  // biome-ignore lint/suspicious/noExplicitAny: the SDK types its own tool list as `Tool<any>[]`.
): Tool<any>[] {
  if (mode === "plan") {
    return [
      defineTool<RawPlan>("submit_plan", {
        description:
          "Submit the plan for this mission: a summary of the approach, the assumptions it rests on, and the ordered tasks. Call it exactly once, after you have investigated.",
        parameters: {
          type: "object",
          properties: {
            summary: {
              type: "string",
              description:
                "How you read the mission and how you intend to approach it, in a few sentences.",
            },
            assumptions: {
              type: "array",
              items: { type: "string" },
              description: "Assumptions the user should check.",
            },
            tasks: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  key: {
                    type: "string",
                    description: "Short id, e.g. `read-app`.",
                  },
                  phase: {
                    type: "string",
                    enum: [
                      "discover",
                      "assess",
                      "design",
                      "build",
                      "verify",
                      "handover",
                    ],
                  },
                  title: { type: "string" },
                  detail: {
                    type: "string",
                    description: "What done looks like for this task.",
                  },
                  dependsOn: {
                    type: "array",
                    items: { type: "string" },
                    description: "Keys of tasks that must finish first.",
                  },
                },
                required: ["key", "phase", "title"],
              },
            },
          },
          required: ["summary", "tasks"],
        },
        skipPermission: true,
        handler: async (raw) => {
          const result = validatePlan(raw ?? {});
          if (!result.ok) return { error: result.error };
          signals.plan = result;
          return {
            accepted: true,
            tasks: result.plan.tasks.length,
            guidance:
              "Plan recorded. End your turn now with a one-paragraph summary.",
          };
        },
      }),
    ];
  }

  return [
    defineTool<{ summary: string }>("complete_task", {
      description:
        "Mark the current task as finished, with a short summary of what you found or changed. The summary is what later tasks are told about this one, so put the facts they need in it.",
      parameters: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
      },
      skipPermission: true,
      handler: async ({ summary }) => {
        signals.completed =
          String(summary ?? "")
            .trim()
            .slice(0, 2000) || "Done.";
        return {
          recorded: true,
          guidance: "End your turn now with a one-line reply.",
        };
      },
    }),
    defineTool<{
      key: string;
      phase: string;
      title: string;
      detail?: string;
    }>("add_task", {
      description:
        "Add a follow-up task to the plan when you discover work it is missing. It runs after the tasks already planned.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string" },
          phase: {
            type: "string",
            enum: [
              "discover",
              "assess",
              "design",
              "build",
              "verify",
              "handover",
            ],
          },
          title: { type: "string" },
          detail: { type: "string" },
        },
        required: ["key", "phase", "title"],
      },
      skipPermission: true,
      handler: async ({ key, phase, title, detail }) => {
        const cleanKey = String(key ?? "").trim();
        if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(cleanKey)) {
          return {
            error: "`key` must be lowercase letters, digits and dashes.",
          };
        }
        if (
          existingKeys.has(cleanKey) ||
          signals.added.some((t) => t.key === cleanKey)
        ) {
          return { error: `A task with key \`${cleanKey}\` already exists.` };
        }
        if (!isPhase(phase)) return { error: "Unknown phase." };
        if (existingKeys.size + signals.added.length >= MAX_RUN_TASKS) {
          return {
            error: `The run already has ${MAX_RUN_TASKS} tasks. Finish what is planned instead.`,
          };
        }
        signals.added.push({
          key: cleanKey,
          phase,
          title:
            String(title ?? "")
              .trim()
              .slice(0, 200) || cleanKey,
          detail: String(detail ?? "")
            .trim()
            .slice(0, 2000),
        });
        return { added: true };
      },
    }),
  ];
}

/**
 * One agent turn inside a run, with the heartbeat, stop watch and live trail
 * around it.
 */
async function iterate(
  run: LoadedRun,
  token: string,
  params: {
    planning: boolean;
    brief: string;
    // biome-ignore lint/suspicious/noExplicitAny: the SDK types its own tool list as `Tool<any>[]`.
    tools: Tool<any>[];
    signal: AbortSignal;
  },
) {
  let lastFlush = 0;
  let flushing = false;
  const onStep = (steps: AgentStep[]) => {
    const now = Date.now();
    if (flushing || now - lastFlush < LIVE_STEPS_INTERVAL_MS) return;
    lastFlush = now;
    flushing = true;
    void database.agentRun
      .update({
        where: { id: run.id },
        data: { liveSteps: json(steps.slice(-40)) },
      })
      .catch(() => {})
      .finally(() => {
        flushing = false;
      });
  };

  const { context, model } = await buildRunContext({
    project: run.project,
    userId: run.userId,
    branch: run.branch,
    token,
    planning: params.planning,
    extraTools: params.tools,
    onStep,
    signal: params.signal,
  });

  // The guidance in this brief is handed over now. Only that much is removed, so
  // anything sent since the run was loaded waits for the next iteration instead of
  // being dropped.
  const handedOver = guidanceOf(run).length;
  const current = await database.agentRun.findUnique({
    where: { id: run.id },
    select: { pendingGuidance: true },
  });

  await database.agentRun.update({
    where: { id: run.id },
    data: {
      iterations: { increment: 1 },
      model,
      liveSteps: json([]),
      pendingGuidance: json(
        strings(current?.pendingGuidance).slice(handedOver),
      ),
    },
  });

  return runProjectAgent(params.brief, context);
}

/** The guidance waiting for the next brief. `iterate` removes it once handed over. */
function guidanceOf(run: AgentRun): string[] {
  return strings(run.pendingGuidance);
}

async function planIteration(
  run: LoadedRun,
  token: string,
  signal: AbortSignal,
): Promise<boolean> {
  const signals = emptySignals();

  let turn: Awaited<ReturnType<typeof runProjectAgent>>;
  try {
    turn = await iterate(run, token, {
      planning: true,
      brief: planningBrief({
        mission: run.mission,
        branch: run.branch,
        guidance: guidanceOf(run),
      }),
      tools: runTools(signals, "plan", new Set()),
      signal,
    });
  } catch (error) {
    if (error instanceof TurnCancelled) return false;
    throw error;
  }

  await addEvent(run.id, "iteration", "Investigated the mission", {
    body: turn.reply,
    data: { steps: turn.steps.length, telemetry: turn.telemetry },
  });

  if (!signals.plan?.ok) {
    // `iterations` was read before this turn counted, hence the + 1.
    if (run.iterations + 1 >= MAX_PLANNING_ATTEMPTS) {
      await setStatus(run.id, "awaiting_input", {
        question: `The agent could not turn the mission into a plan. Its last answer: ${turn.reply.slice(0, 1500)}`,
      });
      await addEvent(run.id, "question", "No plan after several attempts", {
        body: turn.reply,
      });
      return false;
    }
    await addEvent(run.id, "error", "No plan was submitted, retrying", {
      body: turn.reply,
    });
    return true;
  }

  const { plan } = signals.plan;

  await database.$transaction([
    database.agentRunTask.deleteMany({ where: { runId: run.id } }),
    database.agentRunTask.createMany({
      data: plan.tasks.map((task, position) => ({
        runId: run.id,
        key: task.key,
        position,
        phase: task.phase,
        title: task.title,
        detail: task.detail,
        dependsOn: json(task.dependsOn),
      })),
    }),
    database.agentRun.update({
      where: { id: run.id },
      data: {
        planSummary: plan.summary,
        assumptions: json(plan.assumptions),
      },
    }),
  ]);

  await addEvent(run.id, "plan", `Planned ${plan.tasks.length} tasks`, {
    body: plan.summary,
    data: { assumptions: plan.assumptions },
  });

  if (run.autonomy === "supervised") {
    await setStatus(run.id, "awaiting_approval");
    await addEvent(run.id, "approval", "Waiting for your approval of the plan");
    return false;
  }

  await setStatus(run.id, "running");
  return true;
}

async function workIteration(
  run: LoadedRun,
  token: string,
  signal: AbortSignal,
): Promise<boolean> {
  const step = nextStep(
    run.tasks.map((entry) => ({
      ...entry,
      status: entry.status as AgentRunTaskStatus,
      dependsOn: strings(entry.dependsOn),
    })),
  );

  if (step.kind === "done") {
    await handOver(run);
    return false;
  }

  if (step.kind === "blocked") {
    const names = step.failed.map((task) => `"${task.title}"`).join(", ");
    await setStatus(run.id, "awaiting_input", {
      question: `The remaining tasks depend on ${names}, which failed. Try again, or stop the run and review what is on the branch.`,
    });
    await addEvent(run.id, "question", "Blocked on a failed task", {
      body: names,
    });
    return false;
  }

  const task = step.task;
  const attempt = task.attempts + 1;

  await database.agentRunTask.update({
    where: { id: task.id },
    data: {
      status: "in_progress",
      attempts: attempt,
      startedAt: task.startedAt ?? new Date(),
    },
  });
  if (attempt === 1) {
    await addEvent(run.id, "task_started", task.title, {
      taskId: task.id,
      data: { phase: task.phase },
    });
  }

  const check = await readBranchCheck(
    token,
    run.project.repoFullName,
    run.branch,
  );
  const briefTasks: BriefTask[] = run.tasks
    .sort((a, b) => a.position - b.position)
    .map((entry) => ({
      key: entry.key,
      phase: entry.phase as AgentRunPhase,
      title: entry.title,
      detail: entry.detail,
      status: entry.status as BriefTask["status"],
      summary: entry.summary,
    }));
  const self = briefTasks.find((entry) => entry.key === task.key);
  if (!self) throw new Error("Task disappeared from the plan.");

  const signals = emptySignals();
  let turn: Awaited<ReturnType<typeof runProjectAgent>>;
  try {
    turn = await iterate(run, token, {
      planning: false,
      brief: taskBrief({
        mission: run.mission,
        branch: run.branch,
        planSummary: run.planSummary,
        assumptions: strings(run.assumptions),
        task: self,
        tasks: briefTasks,
        attempt,
        guidance: guidanceOf(run),
        lastCheck: check
          ? `\`${check.name}\` on this branch: ${check.status}${check.conclusion ? `, ${check.conclusion}` : ""} (${check.htmlUrl})`
          : null,
      }),
      tools: runTools(
        signals,
        "task",
        new Set(run.tasks.map((entry) => entry.key)),
      ),
      signal,
    });
  } catch (error) {
    if (error instanceof TurnCancelled) {
      // Back to pending, so a resumed run picks the task up again.
      await database.agentRunTask
        .update({ where: { id: task.id }, data: { status: "pending" } })
        .catch(() => {});
      return false;
    }
    throw error;
  }

  // Stopped while the turn was finishing: drop its edits, as the chat does.
  if (signal.aborted) {
    await database.agentRunTask
      .update({ where: { id: task.id }, data: { status: "pending" } })
      .catch(() => {});
    return false;
  }

  // Into the project's decision log, as the chat's are: the edits land on the
  // project branch, so the reasons for them belong where the Logs tab and the
  // chat agent read them. The run's timeline keeps a copy for its own view.
  const decisionIds: string[] = [];
  for (const decision of turn.decisions) {
    try {
      decisionIds.push(
        await recordDecision(run.projectId, "agent", {
          question: decision.question,
          context: decision.context,
          choice: decision.choice,
          reason: decision.reason,
          alternatives: decision.alternatives,
          plan: decision.plan,
          ...(decision.supersedes ? { supersedes: decision.supersedes } : {}),
        }),
      );
    } catch {
      // A decision that cannot be written must not cost the edits it explains.
      decisionIds.push("");
    }
    await addEvent(run.id, "decision", decision.question, {
      taskId: task.id,
      body: `${decision.choice}\n\n${decision.reason}`,
      data: {
        choice: decision.choice,
        reason: decision.reason,
        context: decision.context,
        alternatives: decision.alternatives,
      },
    });
  }

  const commits: string[] = [];
  const failures: string[] = [];
  /** The decision in force when mutation `index` was queued, as the chat does it. */
  const decisionFor = (index: number): string | undefined => {
    for (let i = turn.decisions.length - 1; i >= 0; i--) {
      const decision = turn.decisions[i];
      if (decision && decision.fromMutation <= index) {
        return decisionIds[i] || undefined;
      }
    }
    return undefined;
  };

  for (const [index, mutation] of turn.mutations.entries()) {
    try {
      const decisionId = decisionFor(index);
      // The same commit path as the canvas and the chat: the edit lands on the
      // project branch and shows up in the Logs.
      const result = await applyProjectMutation(token, run.project, mutation, {
        origin: "agent",
        ...(decisionId ? { decisionId } : {}),
      });
      if (result.commit) commits.push(result.commit.sha);
    } catch (error) {
      failures.push(
        error instanceof Error ? error.message : "Unknown mutation error",
      );
    }
  }

  if (commits.length) {
    const fresh = await database.agentRun.findUnique({
      where: { id: run.id },
      select: { commits: true },
    });
    await database.agentRun.update({
      where: { id: run.id },
      data: { commits: json([...strings(fresh?.commits), ...commits]) },
    });
    await addEvent(
      run.id,
      "commit",
      `Pushed ${commits.length} commit${commits.length === 1 ? "" : "s"} to ${run.branch}`,
      { taskId: task.id, data: { commits } },
    );
  }
  for (const failure of failures) {
    await addEvent(run.id, "error", "An edit could not be committed", {
      taskId: task.id,
      body: failure,
    });
  }

  // The agent queued these edits believing they would land, so it has to hear
  // that they did not, or it builds the next task on something that is missing.
  // Read by the next brief through the notes section, then cleared.
  if (failures.length) {
    const current = await database.agentRun.findUnique({
      where: { id: run.id },
      select: { pendingGuidance: true },
    });
    await database.agentRun.update({
      where: { id: run.id },
      data: {
        pendingGuidance: json([
          ...strings(current?.pendingGuidance),
          ...failures.map(
            (failure) =>
              `While working on "${task.title}", an edit was refused and not committed: ${failure}. The project does not contain that change; redo it correctly.`,
          ),
        ]),
      },
    });
  }

  await addEvent(run.id, "iteration", `Worked on: ${task.title}`, {
    taskId: task.id,
    body: turn.reply,
    data: {
      attempt,
      mutations: turn.mutations.length,
      steps: turn.steps,
      telemetry: turn.telemetry,
    },
  });

  if (signals.added.length) {
    const maxPosition = Math.max(
      ...run.tasks.map((entry) => entry.position),
      0,
    );
    await database.agentRunTask.createMany({
      data: signals.added.map((added, index) => ({
        runId: run.id,
        key: added.key,
        position: maxPosition + 1 + index,
        phase: added.phase,
        title: added.title,
        detail: added.detail,
      })),
    });
    await addEvent(
      run.id,
      "plan",
      `Added ${signals.added.length} task${signals.added.length === 1 ? "" : "s"} to the plan`,
      { body: signals.added.map((added) => `- ${added.title}`).join("\n") },
    );
  }

  if (signals.completed && failures.length && attempt < MAX_TASK_ATTEMPTS) {
    // Reported finished, but part of it never reached the repository: the task
    // runs again with the refusals in its brief instead of being marked done.
    await database.agentRunTask.update({
      where: { id: task.id },
      data: { status: "pending" },
    });
  } else if (signals.completed) {
    await database.agentRunTask.update({
      where: { id: task.id },
      data: {
        status: "done",
        summary: signals.completed,
        finishedAt: new Date(),
      },
    });
    await addEvent(run.id, "task_done", task.title, {
      taskId: task.id,
      body: signals.completed,
    });
  } else if (attempt >= MAX_TASK_ATTEMPTS) {
    await database.agentRunTask.update({
      where: { id: task.id },
      data: {
        status: "failed",
        summary: turn.reply.slice(0, 2000),
        finishedAt: new Date(),
      },
    });
    await addEvent(run.id, "task_failed", task.title, {
      taskId: task.id,
      body: `Not finished after ${attempt} attempts.`,
    });
  }

  return true;
}

/**
 * Ends a run whose tasks are all finished.
 *
 * The edits are already on the project branch, committed task by task, so there
 * is nothing left to hand over but the summary.
 */
async function handOver(run: AgentRun): Promise<void> {
  const fresh = await database.agentRun.findUnique({
    where: { id: run.id },
    include: { tasks: true },
  });
  if (!fresh) return;

  const commits = strings(fresh.commits);
  const tasks = fresh.tasks;
  const failed = tasks.filter((task) => task.status === "failed").length;
  const outcome = [
    `${tasks.filter((task) => task.status === "done").length} of ${tasks.length} tasks done`,
    failed ? `${failed} failed` : null,
    `${commits.length} commit${commits.length === 1 ? "" : "s"} to ${run.baseBranch}`,
  ]
    .filter(Boolean)
    .join(", ");

  await setStatus(run.id, "completed", { outcome, question: null });
  await addEvent(run.id, "status", "Mission complete", {
    body: commits.length
      ? `The changes are on ${run.baseBranch} and on the canvas.`
      : "Nothing needed to change.",
    data: { status: "completed" },
  });
}

async function fail(runId: string, message: string): Promise<void> {
  await setStatus(runId, "failed", { error: message }).catch(() => {});
  await addEvent(runId, "error", "The run failed", { body: message });
}
