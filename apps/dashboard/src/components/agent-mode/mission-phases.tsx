"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@terrablox/ui/tooltip";
import { Check, Hand, ListChecks, type LucideIcon, X } from "lucide-react";
import { PHASE_INFO } from "@/lib/agent-runs/types";
import { PHASE_ICONS, type TrackState, type TrackStep } from "./run-ui";

const PLAN_INFO = {
  label: "Plan",
  description: "Investigate the project and turn the mission into tasks.",
};

export function stepInfo(key: TrackStep["key"]): {
  label: string;
  description: string;
  icon: LucideIcon;
} {
  if (key === "plan") return { ...PLAN_INFO, icon: ListChecks };
  return { ...PHASE_INFO[key], icon: PHASE_ICONS[key] };
}

const NODE: Record<TrackState, string> = {
  upcoming: "border-border bg-background text-muted-foreground",
  current:
    "border-sky-500 bg-sky-500 text-white shadow-[0_0_0_4px_rgba(14,165,233,0.15)]",
  waiting:
    "border-amber-500 bg-amber-500/10 text-amber-600 shadow-[0_0_0_4px_rgba(245,158,11,0.15)] dark:text-amber-400",
  done: "border-emerald-500 bg-emerald-500 text-white",
  skipped: "border-dashed border-border bg-background text-muted-foreground/40",
  failed: "border-destructive bg-destructive/10 text-destructive",
};

const LABEL: Record<TrackState, string> = {
  upcoming: "text-muted-foreground",
  current: "font-semibold text-foreground",
  waiting: "font-semibold text-amber-700 dark:text-amber-400",
  done: "text-foreground",
  skipped: "text-muted-foreground/50",
  failed: "text-destructive",
};

/** The agent has gone past this step, so the line leading out of it is drawn. */
function passed(state: TrackState): boolean {
  return state === "done" || state === "skipped" || state === "failed";
}

/**
 * The phases of a mission as a track, with the agent's position on it.
 *
 * The same drawing explains how a mission runs before one starts and shows
 * where it is once it does, so the picture the user learned on the start screen
 * is the one they then watch move.
 */
export function MissionPhases({
  track,
  compact = false,
}: {
  track: TrackStep[];
  compact?: boolean;
}) {
  const size = compact ? "h-7 w-7" : "h-9 w-9";
  const iconSize = compact ? "h-3.5 w-3.5" : "h-4 w-4";
  // Half the node, so the line runs between node edges rather than centres.
  const gap = compact ? "14px" : "18px";

  return (
    // Each step explains itself on hover and on keyboard focus, so the track can
    // stay a row of short labels instead of a paragraph per phase.
    <TooltipProvider delayDuration={150}>
      <ol className="flex items-start" aria-label="Mission phases">
        {track.map((step, index) => {
          const info = stepInfo(step.key);
          const previous = track[index - 1];
          const Icon =
            step.state === "done"
              ? Check
              : step.state === "failed"
                ? X
                : step.state === "waiting"
                  ? Hand
                  : info.icon;

          return (
            <li
              key={step.key}
              className="relative flex min-w-0 flex-1 flex-col items-center text-center"
              aria-current={
                step.state === "current" || step.state === "waiting"
                  ? "step"
                  : undefined
              }
            >
              {previous ? (
                <span
                  aria-hidden
                  className="absolute h-0.5 overflow-hidden rounded-full bg-border"
                  style={{
                    top: `calc(${gap} - 1px)`,
                    left: `calc(-50% + ${gap} + 4px)`,
                    right: `calc(50% + ${gap} + 4px)`,
                  }}
                >
                  <span
                    className={`block h-full bg-gradient-to-r from-emerald-500 to-sky-500 transition-[width] duration-700 ${
                      passed(previous.state) ? "w-full" : "w-0"
                    }`}
                  />
                </span>
              ) : null}

              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={`${info.label}: ${info.description}`}
                    className="relative z-10 flex w-full cursor-help flex-col items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span
                      className={`relative flex shrink-0 items-center justify-center rounded-full border-2 transition-colors duration-500 ${size} ${NODE[step.state]}`}
                    >
                      {step.state === "current" ? (
                        <span className="absolute inset-0 animate-ping rounded-full bg-sky-400/40" />
                      ) : null}
                      <Icon className={`relative ${iconSize}`} />
                    </span>
                    <span
                      className={`mt-1.5 w-full truncate px-0.5 leading-tight ${
                        compact ? "text-[10px]" : "text-xs"
                      } ${LABEL[step.state]}`}
                    >
                      {info.label}
                    </span>
                  </button>
                </TooltipTrigger>
                <TooltipContent
                  className="max-w-56 text-left text-xs"
                  side="bottom"
                >
                  <p className="font-medium">{info.label}</p>
                  <p className="mt-0.5 text-muted-foreground">
                    {info.description}
                  </p>
                </TooltipContent>
              </Tooltip>
              {step.total ? (
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {step.done}/{step.total}
                </span>
              ) : step.state === "current" || step.state === "waiting" ? (
                <span
                  className={`text-[10px] ${
                    step.state === "current"
                      ? "text-sky-600 dark:text-sky-400"
                      : "text-amber-600 dark:text-amber-400"
                  }`}
                >
                  {step.state === "current" ? "now" : "waiting"}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </TooltipProvider>
  );
}
