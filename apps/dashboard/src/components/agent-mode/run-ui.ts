import {
  CheckCircle2,
  ClipboardCheck,
  Compass,
  Flag,
  Hammer,
  Hand,
  Loader2,
  type LucideIcon,
  MessageCircleQuestion,
  PauseCircle,
  Search,
  ShieldCheck,
  Sparkles,
  StopCircle,
  XCircle,
} from "lucide-react";
import type {
  AgentRunPhase,
  AgentRunStatus,
  AgentRunTaskDto,
} from "@/lib/agent-runs/types";

export const PHASE_ICONS: Record<AgentRunPhase, LucideIcon> = {
  discover: Search,
  assess: ClipboardCheck,
  design: Compass,
  build: Hammer,
  verify: ShieldCheck,
  handover: Flag,
};

export interface StatusMeta {
  label: string;
  /** One sentence for the header, saying what happens next. */
  hint: string;
  icon: LucideIcon;
  /** Classes for the pill. */
  tone: string;
  /** Classes for the dot. */
  dot: string;
  spin?: boolean;
}

export const STATUS_META: Record<AgentRunStatus, StatusMeta> = {
  planning: {
    label: "Planning",
    hint: "The agent is investigating the mission and drafting a plan.",
    icon: Sparkles,
    tone: "bg-violet-500/10 text-violet-700 dark:text-violet-300",
    dot: "bg-violet-500",
    spin: false,
  },
  awaiting_approval: {
    label: "Needs your approval",
    hint: "Review the plan. Nothing is built until you approve it.",
    icon: Hand,
    tone: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
    dot: "bg-amber-500",
  },
  running: {
    label: "Working",
    hint: "The agent is working through the plan.",
    icon: Loader2,
    tone: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
    dot: "bg-sky-500",
    spin: true,
  },
  awaiting_input: {
    label: "Has a question",
    hint: "The agent needs an answer from you to continue.",
    icon: MessageCircleQuestion,
    tone: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
    dot: "bg-amber-500",
  },
  paused: {
    label: "Paused",
    hint: "Resume to continue where the agent left off.",
    icon: PauseCircle,
    tone: "bg-muted text-muted-foreground",
    dot: "bg-muted-foreground",
  },
  completed: {
    label: "Completed",
    hint: "The work is ready for review.",
    icon: CheckCircle2,
    tone: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    dot: "bg-emerald-500",
  },
  failed: {
    label: "Failed",
    hint: "Something went wrong. You can resume once it is fixed.",
    icon: XCircle,
    tone: "bg-destructive/10 text-destructive",
    dot: "bg-destructive",
  },
  stopped: {
    label: "Stopped",
    hint: "You stopped this run. What it committed stays.",
    icon: StopCircle,
    tone: "bg-muted text-muted-foreground",
    dot: "bg-muted-foreground",
  },
};

export function isWorking(status: AgentRunStatus): boolean {
  return status === "planning" || status === "running";
}

export function needsUser(status: AgentRunStatus): boolean {
  return status === "awaiting_approval" || status === "awaiting_input";
}

export function isFinished(status: AgentRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "stopped";
}

/** `3m 12s`, `1h 4m`: short enough for a header. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatRelative(iso: string, now = Date.now()): string {
  const diff = now - new Date(iso).getTime();
  if (diff < 45_000) return "just now";
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString();
}

export function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export interface PhaseProgress {
  phase: AgentRunPhase;
  total: number;
  done: number;
  failed: number;
  active: boolean;
}

export function phaseProgress(
  phases: readonly AgentRunPhase[],
  tasks: AgentRunTaskDto[],
): PhaseProgress[] {
  return phases.map((phase) => {
    const own = tasks.filter((task) => task.phase === phase);
    return {
      phase,
      total: own.length,
      done: own.filter((t) => t.status === "done" || t.status === "skipped")
        .length,
      failed: own.filter((t) => t.status === "failed").length,
      active: own.some((t) => t.status === "in_progress"),
    };
  });
}

export type TrackState =
  | "upcoming"
  | "current"
  | "waiting"
  | "done"
  | "skipped"
  | "failed";

export interface TrackStep {
  key: "plan" | AgentRunPhase;
  state: TrackState;
  done: number;
  total: number;
}

/**
 * Where a run is on its way through the phases, planning included.
 *
 * Planning is a step of its own because it is one: the run spends real time
 * there and, when supervised, waits there for approval. `current` is where the
 * agent is working now; `waiting` is where it stopped to wait for the user.
 */
export function phaseTrack(
  phases: readonly AgentRunPhase[],
  run: { status: AgentRunStatus; tasks: AgentRunTaskDto[] } | null,
): TrackStep[] {
  if (!run) {
    return [
      { key: "plan", state: "upcoming", done: 0, total: 0 },
      ...phases.map((phase) => ({
        key: phase,
        state: "upcoming" as const,
        done: 0,
        total: 0,
      })),
    ];
  }

  const { status, tasks } = run;
  const planned = tasks.length > 0;
  const stalled =
    status === "awaiting_input" ||
    status === "paused" ||
    status === "stopped" ||
    status === "failed";

  const planState: TrackState = !planned
    ? status === "planning"
      ? "current"
      : stalled
        ? "waiting"
        : "upcoming"
    : status === "planning"
      ? "current"
      : status === "awaiting_approval"
        ? "waiting"
        : "done";

  // The phase the agent is in: the task in progress, else the next one it will
  // pick up. Only meaningful once the plan is approved.
  const ordered = [...tasks].sort((a, b) => a.position - b.position);
  const focus =
    planned && planState === "done"
      ? (ordered.find((task) => task.status === "in_progress") ??
        ordered.find((task) => task.status === "pending"))
      : undefined;

  return [
    { key: "plan", state: planState, done: 0, total: 0 },
    ...phases.map((phase): TrackStep => {
      const own = tasks.filter((task) => task.phase === phase);
      const done = own.filter(
        (task) => task.status === "done" || task.status === "skipped",
      ).length;
      const failed = own.some((task) => task.status === "failed");
      const open = own.some(
        (task) => task.status === "pending" || task.status === "in_progress",
      );

      let state: TrackState;
      if (planned && own.length === 0) state = "skipped";
      else if (!planned) state = "upcoming";
      else if (focus?.phase === phase) {
        state = status === "running" ? "current" : "waiting";
      } else if (!open && failed) state = "failed";
      else if (!open && own.length > 0) state = "done";
      else state = "upcoming";

      return { key: phase, state, done, total: own.length };
    }),
  ];
}
