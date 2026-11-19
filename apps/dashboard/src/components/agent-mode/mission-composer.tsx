"use client";

import { Button } from "@terrablox/ui/button";
import {
  Bot,
  Boxes,
  Check,
  Cloud,
  FileText,
  FlaskConical,
  GitBranch,
  Hand,
  Loader2,
  Lock,
  type LucideIcon,
  Plug,
  Settings2,
  Sparkles,
  Zap,
} from "lucide-react";
import { useState } from "react";
import {
  AGENT_MISSIONS,
  type AgentMission,
  type AgentMissionId,
  missionUnavailable,
} from "@/lib/agent-runs/missions";
import {
  AGENT_RUN_PHASES,
  type AgentRunAutonomy,
  type AgentRunSources,
} from "@/lib/agent-runs/types";
import { MissionPhases } from "./mission-phases";
import { phaseTrack } from "./run-ui";

const MISSION_ICONS: Record<AgentMissionId, LucideIcon> = {
  "migrate-app": Cloud,
  "mvp-prototype": FlaskConical,
  "architecture-from-documents": FileText,
  "review-harden": Zap,
};

export interface MissionStart {
  missionId: AgentMissionId;
  autonomy: AgentRunAutonomy;
}

interface MissionComposerProps {
  sources: AgentRunSources | null;
  starting: boolean;
  /** Set when another mission is still open, which blocks a new one. */
  blockedBy: string | null;
  onStart: (input: MissionStart) => void;
  /** Opens the agent harness settings, the same dialog the chat opens. */
  onOpenSettings?: () => void;
  /** Laid out for a narrow window rather than a page. */
  compact?: boolean;
}

/**
 * Where a mission begins: pick one, choose how much the agent decides alone,
 * start.
 *
 * No text box on purpose. Each mission is a brief the harness is written for,
 * and the run takes no instructions once it has started either, so what the
 * agent will do is visible here in full before anything happens.
 */
export function MissionComposer({
  sources,
  starting,
  blockedBy,
  onStart,
  onOpenSettings,
  compact = false,
}: MissionComposerProps) {
  const [missionId, setMissionId] = useState<AgentMissionId | null>(null);
  const [autonomy, setAutonomy] = useState<AgentRunAutonomy>("supervised");

  const availability = (mission: AgentMission) =>
    sources
      ? missionUnavailable(mission, sources)
      : "Checking what this project has…";

  const selected =
    AGENT_MISSIONS.find((mission) => mission.id === missionId) ?? null;
  const canStart =
    selected !== null && !availability(selected) && !starting && !blockedBy;

  return (
    <div className="flex min-h-full flex-col">
      <div
        className={`mx-auto w-full flex-1 ${compact ? "px-4 py-5" : "max-w-3xl px-6 py-10"}`}
      >
        <div
          className={`flex flex-col items-center text-center ${compact ? "mb-5" : "mb-8"}`}
        >
          <div className="relative mb-3">
            <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-violet-500/30 to-sky-500/30 blur-xl" />
            <div
              className={`relative flex items-center justify-center rounded-2xl border bg-background shadow-sm ${compact ? "h-11 w-11" : "h-14 w-14"}`}
            >
              <Bot
                className={`text-violet-600 dark:text-violet-400 ${compact ? "h-5 w-5" : "h-7 w-7"}`}
              />
            </div>
          </div>
          <h2
            className={`font-semibold tracking-tight ${compact ? "text-lg" : "text-2xl"}`}
          >
            Choose a mission
          </h2>
          <p className="mt-1.5 max-w-xl text-muted-foreground text-sm">
            The agent plans and builds directly on{" "}
            {sources?.repoBranch ?? "the project branch"}. Nothing is deployed.
          </p>
        </div>

        {/* How a mission runs, and later where it is: the same picture. */}
        <section className="rounded-2xl border bg-muted/20 px-3 pt-4 pb-3">
          <MissionPhases
            track={phaseTrack(AGENT_RUN_PHASES, null)}
            compact={compact}
          />
          <p className="mt-2 text-center text-muted-foreground text-[11px]">
            Hover a step to see what happens in it.
          </p>
        </section>

        {/* Missions */}
        <section className="mt-6">
          <h3 className="mb-2 font-medium text-sm">Mission</h3>
          <div className={`grid gap-2 ${compact ? "" : "sm:grid-cols-2"}`}>
            {AGENT_MISSIONS.map((mission) => (
              <MissionCard
                key={mission.id}
                mission={mission}
                selected={missionId === mission.id}
                unavailable={availability(mission)}
                onSelect={() => setMissionId(mission.id)}
              />
            ))}
          </div>
        </section>

        {/* Autonomy */}
        <section className="mt-6">
          <h3 className="mb-2 font-medium text-sm">
            How much should it decide alone?
          </h3>
          <div className={`grid gap-2 ${compact ? "" : "sm:grid-cols-2"}`}>
            <AutonomyOption
              selected={autonomy === "supervised"}
              onSelect={() => setAutonomy("supervised")}
              icon={Hand}
              title="Review the plan first"
              badge="Recommended"
              description="It starts building once you approve the plan."
            />
            <AutonomyOption
              selected={autonomy === "autonomous"}
              onSelect={() => setAutonomy("autonomous")}
              icon={Zap}
              title="Fully autonomous"
              description="Plans and builds in one go, without stopping."
            />
          </div>
        </section>

        {/* Sources */}
        <section className="mt-6">
          <h3 className="mb-2 font-medium text-sm">
            What the agent works with
          </h3>
          <div className="flex flex-wrap gap-2">
            <SourceChip
              icon={GitBranch}
              label={
                sources
                  ? `${sources.repoFullName}@${sources.repoBranch}`
                  : "Project repository"
              }
              on
            />
            <SourceChip
              icon={Boxes}
              label={
                sources?.appRepoFullName
                  ? `App: ${sources.appRepoFullName}`
                  : "No application linked"
              }
              on={Boolean(sources?.appRepoFullName)}
            />
            <SourceChip
              icon={FileText}
              label={
                sources?.documentCount
                  ? `${sources.documentCount} document${sources.documentCount === 1 ? "" : "s"}`
                  : "No documents"
              }
              on={Boolean(sources?.documentCount)}
            />
            <SourceChip
              icon={Plug}
              label={
                sources?.mcpServerCount
                  ? `${sources.mcpServerCount} MCP server${sources.mcpServerCount === 1 ? "" : "s"}`
                  : "No MCP servers"
              }
              on={Boolean(sources?.mcpServerCount)}
            />
          </div>
        </section>
      </div>

      {/* Sticky, so the start button is in reach however far the list scrolls. */}
      <div className="sticky bottom-0 border-t bg-background/95 backdrop-blur">
        <div
          className={`mx-auto flex w-full items-center gap-3 ${compact ? "px-4 py-3" : "max-w-3xl px-6 py-3"}`}
        >
          {/* Where the chat has it: next to the action, bottom left. */}
          {onOpenSettings ? (
            <Button
              aria-label="Agent settings"
              className="h-8 w-8 shrink-0"
              onClick={onOpenSettings}
              size="icon"
              title="Agent settings"
              variant="ghost"
            >
              <Settings2 className="h-4 w-4" />
            </Button>
          ) : null}
          <p className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
            {blockedBy
              ? blockedBy
              : selected
                ? (availability(selected) ?? selected.title)
                : null}
          </p>
          <Button
            size="sm"
            onClick={() =>
              selected &&
              canStart &&
              onStart({
                missionId: selected.id,
                autonomy,
              })
            }
            disabled={!canStart}
            className="shrink-0 gap-1.5 bg-gradient-to-r from-violet-600 to-sky-600 text-white hover:opacity-90"
          >
            {starting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            {starting ? "Starting…" : "Start mission"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function MissionCard({
  mission,
  selected,
  unavailable,
  onSelect,
}: {
  mission: AgentMission;
  selected: boolean;
  unavailable: string | null;
  onSelect: () => void;
}) {
  const Icon = MISSION_ICONS[mission.id];
  const disabled = unavailable !== null;

  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-disabled={disabled}
      onClick={() => {
        if (!disabled) onSelect();
      }}
      title={unavailable ?? mission.mission}
      className={`relative flex items-start gap-3 rounded-xl border p-3.5 text-left transition-all ${
        disabled
          ? "cursor-not-allowed opacity-55"
          : selected
            ? "border-violet-500/60 bg-violet-500/5 ring-1 ring-violet-500/30"
            : "hover:border-foreground/20 hover:bg-muted/30"
      }`}
    >
      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
          selected
            ? "bg-violet-500/15 text-violet-700 dark:text-violet-300"
            : "bg-muted text-muted-foreground"
        }`}
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 pr-5">
        <span className="block font-medium text-sm">{mission.title}</span>
        <span className="mt-0.5 block text-muted-foreground text-xs leading-5">
          {mission.summary}
        </span>
        {disabled ? (
          <span className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-400">
            <Lock className="h-3 w-3" />
            {unavailable}
          </span>
        ) : null}
      </span>
      {selected ? (
        <Check className="absolute top-3 right-3 h-4 w-4 text-violet-600 dark:text-violet-400" />
      ) : null}
    </button>
  );
}

function AutonomyOption({
  selected,
  onSelect,
  icon: Icon,
  title,
  description,
  badge,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: LucideIcon;
  title: string;
  description: string;
  badge?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`relative flex items-start gap-3 rounded-xl border p-3.5 text-left transition-all ${
        selected
          ? "border-violet-500/60 bg-violet-500/5 ring-1 ring-violet-500/30"
          : "hover:border-foreground/20 hover:bg-muted/30"
      }`}
    >
      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
          selected
            ? "bg-violet-500/15 text-violet-700 dark:text-violet-300"
            : "bg-muted text-muted-foreground"
        }`}
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 pr-5">
        <span className="flex flex-wrap items-center gap-2 font-medium text-sm">
          {title}
          {badge ? (
            <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 font-medium text-[10px] text-emerald-700 dark:text-emerald-400">
              {badge}
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 block text-muted-foreground text-xs leading-5">
          {description}
        </span>
      </span>
      {selected ? (
        <Check className="absolute top-3 right-3 h-4 w-4 text-violet-600 dark:text-violet-400" />
      ) : null}
    </button>
  );
}

function SourceChip({
  icon: Icon,
  label,
  on,
}: {
  icon: LucideIcon;
  label: string;
  on: boolean;
}) {
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
        on ? "bg-background" : "border-dashed text-muted-foreground"
      }`}
    >
      <Icon className="h-3 w-3 shrink-0" />
      <span className="truncate">{label}</span>
      {on ? <Check className="h-3 w-3 shrink-0 text-emerald-600" /> : null}
    </span>
  );
}
