/**
 * Agent mode: the shapes the server and the Agent tab share.
 *
 * Types and constants only, so the client can import them without pulling in
 * anything that talks to the database or the Copilot runtime.
 */
import type { AgentStep } from "@/lib/projects/types";

/**
 * The stages a migration goes through, in order.
 *
 * Fixed rather than invented by the planner, so every run reads the same way and
 * the UI can draw a stable progress rail. The planner decides which tasks go into
 * which phase, and may leave a phase empty.
 */
export const AGENT_RUN_PHASES = [
  "discover",
  "assess",
  "design",
  "build",
  "verify",
  "handover",
] as const;

export type AgentRunPhase = (typeof AGENT_RUN_PHASES)[number];

export const PHASE_INFO: Record<
  AgentRunPhase,
  { label: string; description: string }
> = {
  discover: {
    label: "Discover",
    description:
      "Read the application, the documents and the current Terraform to learn what exists.",
  },
  assess: {
    label: "Assess",
    description:
      "Decide per workload how it moves: rehost, replatform, refactor, retain or retire.",
  },
  design: {
    label: "Design",
    description:
      "Choose the target architecture and record each decision with its alternatives.",
  },
  build: {
    label: "Build",
    description: "Place and wire modules on the project branch.",
  },
  verify: {
    label: "Verify",
    description:
      "Check that the configuration is complete and that the pipeline accepts it.",
  },
  handover: {
    label: "Hand over",
    description: "Summarise the result, the cutover steps and the risks.",
  },
};

export type AgentRunStatus =
  | "planning"
  | "awaiting_approval"
  | "running"
  | "awaiting_input"
  | "paused"
  | "completed"
  | "failed"
  | "stopped";

/** The agent is working: a runner holds the run. */
export const WORKING_STATUSES: readonly AgentRunStatus[] = [
  "planning",
  "running",
];

/** The run is waiting for the user before it can continue. */
export const WAITING_STATUSES: readonly AgentRunStatus[] = [
  "awaiting_approval",
  "awaiting_input",
  "paused",
];

/** The run is over and will not continue. */
export const FINISHED_STATUSES: readonly AgentRunStatus[] = [
  "completed",
  "failed",
  "stopped",
];

export type AgentRunAutonomy = "supervised" | "autonomous";

export type AgentRunTaskStatus =
  | "pending"
  | "in_progress"
  | "done"
  | "failed"
  | "skipped";

export type AgentRunEventKind =
  | "status"
  | "plan"
  | "task_started"
  | "task_done"
  | "task_failed"
  | "iteration"
  | "commit"
  | "check"
  | "decision"
  | "guidance"
  | "question"
  | "approval"
  | "pull_request"
  | "error";

export interface AgentRunTaskDto {
  id: string;
  key: string;
  position: number;
  phase: AgentRunPhase;
  title: string;
  detail: string;
  dependsOn: string[];
  status: AgentRunTaskStatus;
  attempts: number;
  summary: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface AgentRunEventDto {
  id: string;
  taskId: string | null;
  kind: AgentRunEventKind;
  title: string;
  body: string | null;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface AgentRunSummaryDto {
  id: string;
  mission: string;
  /** The catalogue title of the mission. */
  title: string;
  status: AgentRunStatus;
  autonomy: AgentRunAutonomy;
  tasksDone: number;
  tasksTotal: number;
  prUrl: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface AgentRunDto extends AgentRunSummaryDto {
  planSummary: string | null;
  assumptions: string[];
  baseBranch: string;
  branch: string;
  /** Where the branch can be looked at on GitHub. */
  branchUrl: string;
  /** The branch's commit history on GitHub. */
  commitsUrl: string;
  iterations: number;
  maxIterations: number;
  commits: string[];
  question: string | null;
  pendingGuidance: string[];
  liveSteps: AgentStep[];
  prNumber: number | null;
  outcome: string | null;
  error: string | null;
  startedAt: string;
  /** Whether a runner in some process is working on the run right now. */
  live: boolean;
  tasks: AgentRunTaskDto[];
  events: AgentRunEventDto[];
}

/** What the agent will be able to read, shown before a mission starts. */
export interface AgentRunSources {
  repoFullName: string;
  repoBranch: string;
  appRepoFullName: string | null;
  documentCount: number;
  mcpServerCount: number;
  awsConnected: boolean;
}

/**
 * Everything the user can do to a run.
 *
 * Buttons only: Agent mode takes no free text. A run that cannot continue on its
 * own is retried or stopped, never talked to.
 */
export type AgentRunAction =
  | { action: "approve" }
  | { action: "retry" }
  | { action: "stop" }
  | { action: "resume" };
