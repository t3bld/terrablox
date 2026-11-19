/**
 * The pure half of Agent mode: what a valid plan is, which task runs next, and
 * what the agent is told at each step.
 *
 * Kept free of the database and the runtime so it can be tested directly.
 */
import {
  AGENT_RUN_PHASES,
  type AgentRunPhase,
  type AgentRunTaskStatus,
  PHASE_INFO,
} from "./types";

/** More than this and a plan is a backlog rather than a plan. */
export const MAX_PLAN_TASKS = 20;
/** Room for follow-up tasks the agent adds while it works. */
export const MAX_RUN_TASKS = 30;
/** Attempts per task before it is marked failed. */
export const MAX_TASK_ATTEMPTS = 2;
/** Planning turns before the run stops to say it could not make a plan. */
export const MAX_PLANNING_ATTEMPTS = 3;

/**
 * The most turns a run can need, derived from the limits above.
 *
 * The user does not choose a budget: a run goes until its plan is done. This
 * ceiling only exists so that a run whose bookkeeping went wrong cannot spend
 * Copilot quota forever. A run working as designed never reaches it, because
 * every turn either finishes a task or uses up one of its attempts.
 */
export const RUN_STEP_CEILING =
  MAX_PLANNING_ATTEMPTS + MAX_RUN_TASKS * MAX_TASK_ATTEMPTS;

export interface PlannedTask {
  key: string;
  phase: AgentRunPhase;
  title: string;
  detail: string;
  dependsOn: string[];
}

export interface SubmittedPlan {
  summary: string;
  assumptions: string[];
  tasks: PlannedTask[];
}

/** What the model sends to `submit_plan`, before it is trusted. */
export interface RawPlan {
  summary?: unknown;
  assumptions?: unknown;
  tasks?: unknown;
}

const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * Checks a submitted plan and normalises it, or says what is wrong with it.
 *
 * The error is written for the model: it is handed straight back as the tool
 * result, so the agent can fix the plan in the same turn.
 */
export function validatePlan(
  raw: RawPlan,
): { ok: true; plan: SubmittedPlan } | { ok: false; error: string } {
  const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
  if (!summary) return { ok: false, error: "`summary` is required." };

  const assumptions = Array.isArray(raw.assumptions)
    ? raw.assumptions
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .slice(0, 12)
    : [];

  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) {
    return { ok: false, error: "`tasks` must list at least one task." };
  }
  if (raw.tasks.length > MAX_PLAN_TASKS) {
    return {
      ok: false,
      error: `A plan may have at most ${MAX_PLAN_TASKS} tasks; this one has ${raw.tasks.length}. Merge related steps.`,
    };
  }

  const tasks: PlannedTask[] = [];
  const keys = new Set<string>();

  for (const [index, entry] of raw.tasks.entries()) {
    const task = (entry ?? {}) as Record<string, unknown>;
    const key = typeof task.key === "string" ? task.key.trim() : "";
    const title = typeof task.title === "string" ? task.title.trim() : "";
    const phase = task.phase;

    if (!KEY_PATTERN.test(key)) {
      return {
        ok: false,
        error: `Task ${index + 1}: \`key\` must be lowercase letters, digits and dashes, e.g. \`read-app\`.`,
      };
    }
    if (keys.has(key)) {
      return { ok: false, error: `Task key \`${key}\` is used twice.` };
    }
    if (!title) {
      return { ok: false, error: `Task \`${key}\` has no title.` };
    }
    if (!isPhase(phase)) {
      return {
        ok: false,
        error: `Task \`${key}\`: \`phase\` must be one of ${AGENT_RUN_PHASES.join(", ")}.`,
      };
    }

    keys.add(key);
    tasks.push({
      key,
      phase,
      title: title.slice(0, 200),
      detail:
        typeof task.detail === "string"
          ? task.detail.trim().slice(0, 2000)
          : "",
      dependsOn: Array.isArray(task.dependsOn)
        ? task.dependsOn.filter((dep): dep is string => typeof dep === "string")
        : [],
    });
  }

  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!keys.has(dep)) {
        return {
          ok: false,
          error: `Task \`${task.key}\` depends on \`${dep}\`, which is not in the plan.`,
        };
      }
      if (dep === task.key) {
        return {
          ok: false,
          error: `Task \`${task.key}\` depends on itself.`,
        };
      }
    }
  }

  if (hasCycle(tasks)) {
    return { ok: false, error: "The task dependencies form a cycle." };
  }

  // Phase order first, the planner's own order within a phase. A plan that lists
  // a build step before discovery is almost certainly a listing accident, and
  // running it in that order would build on guesses.
  const ordered = tasks
    .map((task, index) => ({ task, index }))
    .sort(
      (a, b) =>
        AGENT_RUN_PHASES.indexOf(a.task.phase) -
          AGENT_RUN_PHASES.indexOf(b.task.phase) || a.index - b.index,
    )
    .map(({ task }) => task);

  return {
    ok: true,
    plan: { summary: summary.slice(0, 4000), assumptions, tasks: ordered },
  };
}

export function isPhase(value: unknown): value is AgentRunPhase {
  return AGENT_RUN_PHASES.includes(value as AgentRunPhase);
}

function hasCycle(tasks: PlannedTask[]): boolean {
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  const state = new Map<string, "visiting" | "done">();

  const visit = (key: string): boolean => {
    const seen = state.get(key);
    if (seen === "visiting") return true;
    if (seen === "done") return false;
    state.set(key, "visiting");
    for (const dep of byKey.get(key)?.dependsOn ?? []) {
      if (visit(dep)) return true;
    }
    state.set(key, "done");
    return false;
  };

  return tasks.some((task) => visit(task.key));
}

export interface SchedulableTask {
  key: string;
  position: number;
  status: AgentRunTaskStatus;
  dependsOn: string[];
}

/**
 * What the run does next.
 *
 * `task` is the first pending task whose dependencies are all finished. `done`
 * means nothing is left to do. `blocked` means tasks are left but every one waits
 * on a task that failed, which only the user can resolve.
 */
export function nextStep<T extends SchedulableTask>(
  tasks: T[],
):
  | { kind: "task"; task: T }
  | { kind: "done" }
  | { kind: "blocked"; failed: T[] } {
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  const finished = (key: string) => {
    const status = byKey.get(key)?.status;
    // A dependency that no longer exists cannot be waited for.
    return status === undefined || status === "done" || status === "skipped";
  };

  const open = [...tasks]
    .filter(
      (task) => task.status === "pending" || task.status === "in_progress",
    )
    .sort((a, b) => a.position - b.position);

  const runnable = open.find((task) => task.dependsOn.every(finished));
  if (runnable) return { kind: "task", task: runnable };

  // Nothing open: finished, even if some tasks failed. The hand-over says which.
  if (open.length === 0) return { kind: "done" };

  return {
    kind: "blocked",
    failed: tasks.filter((task) => task.status === "failed"),
  };
}

/** Shared framing for every turn of a run. */
function runPreamble(mission: string, branch: string): string[] {
  return [
    "You are working in Agent mode: an autonomous, multi-step run on a mission the user gave you.",
    `Every edit you queue is committed directly to the project branch \`${branch}\`, the same way the chat's edits are, and shows up on the canvas. Nothing is deployed.`,
    "Nobody reads your replies between steps and nobody can answer questions. Do not ask for confirmation. Where a fact is missing, make the most reasonable assumption, state it, and carry on.",
    "",
    "## Mission",
    mission,
  ];
}

export function planningBrief(params: {
  mission: string;
  branch: string;
  guidance: string[];
}): string {
  return [
    ...runPreamble(params.mission, params.branch),
    "",
    "## Your job in this step: plan",
    "Investigate before you plan. Read the context documents, the linked application repository and the current project as far as they help you understand the mission. Do not queue any edits in this step.",
    "Then call `submit_plan` exactly once with the tasks that achieve the mission. Use these phases, in this order, and leave out phases that do not apply:",
    ...AGENT_RUN_PHASES.map(
      (phase) => `- \`${phase}\`: ${PHASE_INFO[phase].description}`,
    ),
    "Each task should be one coherent piece of work that one turn can finish: for example 'Network and VPC', not 'Build everything'. List the assumptions you are making so the user can check them.",
    ...guidanceSection(params.guidance),
  ].join("\n");
}

export interface BriefTask {
  key: string;
  phase: AgentRunPhase;
  title: string;
  detail: string;
  status: AgentRunTaskStatus;
  summary: string | null;
}

export function taskBrief(params: {
  mission: string;
  branch: string;
  planSummary: string | null;
  assumptions: string[];
  task: BriefTask;
  tasks: BriefTask[];
  attempt: number;
  guidance: string[];
  lastCheck: string | null;
}): string {
  const finished = params.tasks.filter(
    (task) => task.status === "done" && task.summary,
  );
  const upcoming = params.tasks.filter(
    (task) => task.status === "pending" && task.key !== params.task.key,
  );

  return [
    ...runPreamble(params.mission, params.branch),
    ...(params.planSummary ? ["", "## Approved plan", params.planSummary] : []),
    ...(params.assumptions.length
      ? ["", "Assumptions:", ...params.assumptions.map((a) => `- ${a}`)]
      : []),
    ...(finished.length
      ? [
          "",
          "## Done so far",
          ...finished.map(
            (task) => `- [${task.phase}] ${task.title}: ${task.summary}`,
          ),
        ]
      : []),
    ...(upcoming.length
      ? [
          "",
          "## Still to come (not your job now)",
          ...upcoming.map((task) => `- [${task.phase}] ${task.title}`),
        ]
      : []),
    ...(params.lastCheck ? ["", "## Last check", params.lastCheck] : []),
    "",
    `## Your task now: ${params.task.title}`,
    `Phase: ${params.task.phase} (${PHASE_INFO[params.task.phase].description})`,
    ...(params.task.detail ? [params.task.detail] : []),
    ...(params.attempt > 1
      ? [
          "",
          `This is attempt ${params.attempt}. The previous attempt ended without calling \`complete_task\`. Finish the task this time, making assumptions where you have to.`,
        ]
      : []),
    "",
    "Work only on this task. Record decisions with `record_decision` as you make them. If you changed the project, call `review_project` and fix what it reports.",
    "When the task is finished, call `complete_task` with a short summary of what you found or changed. If you notice work the plan is missing, add it with `add_task`.",
    "Every edit is checked before it is committed, and an edit that would leave a file unparseable is refused. For multi-line values such as scripts or policies, pass the text as it is or as a heredoc (`<<-EOT` … `EOT`); never escape newlines or quotes yourself.",
    ...guidanceSection(params.guidance),
  ].join("\n");
}

function guidanceSection(guidance: string[]): string[] {
  if (guidance.length === 0) return [];
  return [
    "",
    "## Notes since your last step",
    "These come from the system that commits your edits. Act on them before anything else.",
    ...guidance.map((entry) => `- ${entry}`),
  ];
}
