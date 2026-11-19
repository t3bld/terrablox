"use client";

import { Button } from "@terrablox/ui/button";
import {
  AlertCircle,
  ArrowLeft,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDot,
  ExternalLink,
  GitBranch,
  GitCommit,
  GitPullRequest,
  Hand,
  Lightbulb,
  ListChecks,
  Loader2,
  type LucideIcon,
  MessageCircleQuestion,
  MessageSquare,
  Play,
  RefreshCw,
  SkipForward,
  Sparkles,
  Square,
  Wrench,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AgentMarkdown } from "@/components/project-detail/agent-markdown";
import {
  AGENT_RUN_PHASES,
  type AgentRunAction,
  type AgentRunDto,
  type AgentRunEventDto,
  type AgentRunEventKind,
  type AgentRunTaskDto,
  PHASE_INFO,
} from "@/lib/agent-runs/types";
import type { AgentStep } from "@/lib/projects/types";
import { MissionPhases, stepInfo } from "./mission-phases";
import {
  formatClock,
  formatDuration,
  isFinished,
  isWorking,
  PHASE_ICONS,
  phaseTrack,
  STATUS_META,
  type TrackStep,
} from "./run-ui";

interface RunViewProps {
  run: AgentRunDto;
  acting: AgentRunAction["action"] | null;
  onAct: (action: AgentRunAction) => void;
  onBack: () => void;
  /**
   * Laid out for a narrow window: one column, the plan folded into it.
   *
   * A prop rather than a breakpoint, because the view lives in a floating window
   * whose width has nothing to do with the viewport's.
   */
  compact?: boolean;
}

/**
 * One mission, as a control room.
 *
 * Three questions, answered top to bottom: where is it (header and phase rail),
 * does it need me (the attention card, only when it does), and what is it doing
 * (the plan on the left, the timeline on the right). Steering is always one text
 * box away while the run is open.
 */
export function RunView({
  run,
  acting,
  onAct,
  onBack,
  compact = false,
}: RunViewProps) {
  const [focusTask, setFocusTask] = useState<string | null>(null);
  const toggleFocus = (id: string) =>
    setFocusTask((current) => (current === id ? null : id));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <RunHeader
        run={run}
        acting={acting}
        onAct={onAct}
        onBack={onBack}
        compact={compact}
      />

      <div className="flex min-h-0 flex-1">
        {/* Plan */}
        {compact ? null : (
          <aside className="hidden w-80 shrink-0 overflow-y-auto border-r bg-muted/10 md:block xl:w-96">
            <PlanBoard
              run={run}
              focusTask={focusTask}
              onFocusTask={toggleFocus}
            />
          </aside>
        )}

        {/* Activity */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div
              className={`mx-auto w-full max-w-3xl space-y-4 ${
                compact ? "px-3 py-3" : "px-4 py-5 sm:px-6"
              }`}
            >
              <AttentionCard run={run} acting={acting} onAct={onAct} />
              {/* Without a column of its own, the plan folds into the feed. */}
              <div className={compact ? "" : "md:hidden"}>
                <FoldedPlan
                  run={run}
                  focusTask={focusTask}
                  onFocusTask={toggleFocus}
                />
              </div>
              {isWorking(run.status) ? <LiveActivity run={run} /> : null}
              <Timeline
                run={run}
                focusTask={focusTask}
                onClearFocus={() => setFocusTask(null)}
              />
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

/**
 * The plan as a disclosure, for layouts without a plan column.
 *
 * Open while the plan is what the user has to judge, folded once the run is
 * under way: then the live activity is the more useful thing to see first.
 */
function FoldedPlan({
  run,
  focusTask,
  onFocusTask,
}: {
  run: AgentRunDto;
  focusTask: string | null;
  onFocusTask: (id: string) => void;
}) {
  const [open, setOpen] = useState(run.status === "awaiting_approval");
  const current = run.tasks.find((task) => task.status === "in_progress");

  useEffect(() => {
    if (run.status === "awaiting_approval") setOpen(true);
  }, [run.status]);

  return (
    <section className="rounded-xl border bg-muted/10">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
      >
        <ListChecks className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="font-medium text-sm">Plan</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
          {run.tasksTotal
            ? `${run.tasksDone}/${run.tasksTotal} done${current ? ` · ${current.title}` : ""}`
            : run.status === "planning"
              ? "Drafting…"
              : "No plan yet"}
        </span>
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
      </button>
      {open ? (
        <div className="-mt-2 border-t">
          <PlanBoard
            run={run}
            focusTask={focusTask}
            onFocusTask={onFocusTask}
            hideHeading
          />
        </div>
      ) : null}
    </section>
  );
}

// ---- Header -----------------------------------------------------------------

function RunHeader({ run, acting, onAct, onBack, compact }: RunViewProps) {
  const meta = STATUS_META[run.status];
  const StatusIcon = meta.icon;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (isFinished(run.status)) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [run.status]);

  const elapsed =
    (run.finishedAt ? new Date(run.finishedAt).getTime() : now) -
    new Date(run.startedAt).getTime();
  const track = phaseTrack(AGENT_RUN_PHASES, run);

  return (
    <header className="shrink-0 border-b bg-background">
      <div
        className={`flex flex-wrap items-start gap-3 ${compact ? "px-3 pt-3" : "px-4 pt-4 sm:px-6"}`}
      >
        <Button
          variant="ghost"
          size="icon"
          className="-ml-2 h-8 w-8 shrink-0"
          onClick={onBack}
          aria-label="All missions"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-medium text-xs ${meta.tone}`}
            >
              {isWorking(run.status) && !run.live ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <StatusIcon
                  className={`h-3 w-3 ${meta.spin ? "animate-spin" : ""}`}
                />
              )}
              {meta.label}
            </span>
            <span className="text-muted-foreground text-xs">
              {run.autonomy === "autonomous" ? "Autonomous" : "Supervised"} ·{" "}
              {formatDuration(elapsed)}
            </span>
          </div>
          <h2
            className="mt-1.5 truncate font-semibold text-base leading-6"
            title={run.mission}
          >
            {run.title}
          </h2>
          <a
            href={run.branchUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-flex max-w-full items-center gap-1 truncate font-mono text-muted-foreground text-xs hover:text-foreground"
          >
            <GitBranch className="h-3 w-3 shrink-0" />
            <span className="truncate">{run.branch}</span>
            {/* Runs from before Agent mode committed to the project branch. */}
            {run.branch !== run.baseBranch ? (
              <span className="shrink-0">← {run.baseBranch}</span>
            ) : null}
          </a>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {run.prUrl ? (
            <Button size="sm" asChild className="gap-1.5">
              <a href={run.prUrl} target="_blank" rel="noreferrer">
                <GitPullRequest className="h-4 w-4" />
                Review PR #{run.prNumber}
              </a>
            </Button>
          ) : null}
          {!isFinished(run.status) ? (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              disabled={acting !== null}
              onClick={() => onAct({ action: "stop" })}
            >
              {acting === "stop" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Square className="h-3.5 w-3.5" />
              )}
              Stop
            </Button>
          ) : null}
        </div>
      </div>

      {/* Where the agent is: the same track the start screen explains. */}
      <div className={compact ? "px-3 pt-3 pb-3" : "px-4 pt-4 pb-4 sm:px-6"}>
        <MissionPhases track={track} compact={compact} />
        <NowLine run={run} track={track} />
      </div>
    </header>
  );
}

// ---- Attention ----------------------------------------------------------------

/**
 * The one thing the user should do now, if there is one.
 *
 * Only ever one card, at the top, so a run that needs a person never hides the
 * request somewhere in the timeline. Buttons only: the run takes no free text.
 */
function AttentionCard({ run, acting, onAct }: Omit<RunViewProps, "onBack">) {
  if (run.status === "awaiting_approval") {
    return (
      <Card
        tone="amber"
        icon={Hand}
        title={`Review the plan · ${run.tasksTotal} task${run.tasksTotal === 1 ? "" : "s"}`}
      >
        {run.planSummary ? <Expandable markdown={run.planSummary} /> : null}
        {run.assumptions.length ? (
          <Fold
            icon={Lightbulb}
            label={`${run.assumptions.length} assumption${run.assumptions.length === 1 ? "" : "s"} to check`}
          >
            <ul className="space-y-1 text-muted-foreground text-xs">
              {run.assumptions.map((assumption) => (
                <li key={assumption} className="flex gap-1.5">
                  <span aria-hidden>•</span>
                  {assumption}
                </li>
              ))}
            </ul>
          </Fold>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <ActionButton
            acting={acting}
            action="approve"
            icon={Play}
            onClick={() => onAct({ action: "approve" })}
          >
            Approve and build
          </ActionButton>
          <ActionButton
            acting={acting}
            action="stop"
            icon={Square}
            variant="outline"
            onClick={() => onAct({ action: "stop" })}
          >
            Discard
          </ActionButton>
        </div>
      </Card>
    );
  }

  if (run.status === "awaiting_input") {
    return (
      <Card tone="amber" icon={AlertCircle} title="The agent is stuck">
        <Expandable
          markdown={run.question ?? "The agent could not continue on its own."}
        />
        <div className="mt-4 flex flex-wrap gap-2">
          <ActionButton
            acting={acting}
            action="retry"
            icon={RefreshCw}
            onClick={() => onAct({ action: "retry" })}
          >
            Try again
          </ActionButton>
          <ActionButton
            acting={acting}
            action="stop"
            icon={Square}
            variant="outline"
            onClick={() => onAct({ action: "stop" })}
          >
            Stop
          </ActionButton>
        </div>
      </Card>
    );
  }

  if (
    run.status === "paused" ||
    run.status === "stopped" ||
    run.status === "failed"
  ) {
    return (
      <Card
        tone={run.status === "failed" ? "red" : "muted"}
        icon={
          run.status === "failed" ? AlertCircle : STATUS_META[run.status].icon
        }
        title={
          run.status === "failed"
            ? "The run failed"
            : run.status === "stopped"
              ? "You stopped this run"
              : "The run is paused"
        }
      >
        <Expandable
          markdown={run.error ?? run.question ?? STATUS_META[run.status].hint}
        />
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <ActionButton
            acting={acting}
            action="resume"
            icon={Play}
            onClick={() => onAct({ action: "resume" })}
          >
            Resume
          </ActionButton>
        </div>
      </Card>
    );
  }

  if (run.status === "completed") {
    return (
      <Card tone="green" icon={CheckCircle2} title="Mission complete">
        {run.outcome ? <p className="text-sm">{run.outcome}.</p> : null}
        {run.error ? (
          <p className="mt-2 text-destructive text-xs">{run.error}</p>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          {run.commits.length ? (
            <Button size="sm" variant="outline" asChild className="gap-1.5">
              <a href={run.commitsUrl} target="_blank" rel="noreferrer">
                <GitCommit className="h-3.5 w-3.5" />
                View {run.commits.length} commit
                {run.commits.length === 1 ? "" : "s"}
              </a>
            </Button>
          ) : null}
          {run.prUrl ? (
            <Button size="sm" variant="ghost" asChild className="gap-1.5">
              <a href={run.prUrl} target="_blank" rel="noreferrer">
                <GitPullRequest className="h-3.5 w-3.5" />
                Pull request #{run.prNumber}
              </a>
            </Button>
          ) : null}
        </div>
      </Card>
    );
  }

  return null;
}

function ActionButton({
  acting,
  action,
  icon: Icon,
  variant,
  onClick,
  children,
}: {
  acting: AgentRunAction["action"] | null;
  action: AgentRunAction["action"];
  icon: LucideIcon;
  variant?: "outline";
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      size="sm"
      variant={variant}
      className="gap-1.5"
      disabled={acting !== null}
      onClick={onClick}
    >
      {acting === action ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Icon className="h-3.5 w-3.5" />
      )}
      {children}
    </Button>
  );
}

/**
 * One line under the track saying what the highlighted step means right now.
 */
function NowLine({ run, track }: { run: AgentRunDto; track: TrackStep[] }) {
  const step = track.find(
    (entry) => entry.state === "current" || entry.state === "waiting",
  );
  if (!step) {
    return run.status === "completed" ? (
      <p className="mt-3 flex items-center justify-center gap-1.5 text-emerald-700 text-xs dark:text-emerald-400">
        <CheckCircle2 className="h-3.5 w-3.5" />
        All phases finished
      </p>
    ) : null;
  }

  const info = stepInfo(step.key);
  const task =
    step.key === "plan"
      ? null
      : (run.tasks.find((entry) => entry.status === "in_progress") ??
        run.tasks
          .filter(
            (entry) => entry.phase === step.key && entry.status === "pending",
          )
          .sort((a, b) => a.position - b.position)[0]);
  const working = step.state === "current";

  return (
    <div
      className={`mt-3 flex items-start gap-2 rounded-lg px-3 py-2 text-xs ${
        working
          ? "bg-sky-500/5 text-sky-900 dark:text-sky-100"
          : "bg-amber-500/5 text-amber-900 dark:text-amber-100"
      }`}
      aria-live="polite"
    >
      {working ? (
        <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-sky-500" />
      ) : (
        <Hand className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
      )}
      <span className="min-w-0 truncate">
        <span className="font-semibold">
          {working ? "Now" : "Waiting"} · {info.label}
        </span>
        {task ? (
          <span className="text-muted-foreground"> · {task.title}</span>
        ) : null}
      </span>
    </div>
  );
}

/**
 * Long agent text, three lines until asked for more.
 *
 * The agent writes paragraphs; the card only has to say enough to act on.
 */
function Expandable({ markdown }: { markdown: string }) {
  const [open, setOpen] = useState(false);
  const long = markdown.length > 220 || markdown.split("\n").length > 3;

  return (
    <div className="text-sm">
      <div className={open || !long ? "" : "line-clamp-3"}>
        <AgentMarkdown>{markdown}</AgentMarkdown>
      </div>
      {long ? (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="mt-1 text-muted-foreground text-xs hover:text-foreground hover:underline"
        >
          {open ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

/** A labelled section that stays closed until opened. */
function Fold({
  icon: Icon,
  label,
  children,
}: {
  icon: LucideIcon;
  label: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex items-center gap-1.5 font-medium text-xs hover:underline"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        <Icon className="h-3.5 w-3.5 text-amber-500" />
        {label}
      </button>
      {open ? (
        <div className="mt-2 rounded-lg border bg-background/60 p-3">
          {children}
        </div>
      ) : null}
    </div>
  );
}

const CARD_TONES = {
  amber:
    "border-amber-500/40 bg-amber-500/[0.04] [&_[data-icon]]:bg-amber-500/15 [&_[data-icon]]:text-amber-600 dark:[&_[data-icon]]:text-amber-400",
  green:
    "border-emerald-500/40 bg-emerald-500/[0.04] [&_[data-icon]]:bg-emerald-500/15 [&_[data-icon]]:text-emerald-600",
  red: "border-destructive/40 bg-destructive/[0.04] [&_[data-icon]]:bg-destructive/15 [&_[data-icon]]:text-destructive",
  muted:
    "bg-muted/30 [&_[data-icon]]:bg-muted [&_[data-icon]]:text-muted-foreground",
} as const;

function Card({
  tone,
  icon: Icon,
  title,
  children,
}: {
  tone: keyof typeof CARD_TONES;
  icon: LucideIcon;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={`rounded-2xl border p-4 shadow-sm sm:p-5 ${CARD_TONES[tone]}`}
      aria-live="polite"
    >
      <h3 className="mb-3 flex items-center gap-2 font-semibold text-sm">
        <span
          data-icon
          className="flex h-7 w-7 items-center justify-center rounded-lg"
        >
          <Icon className="h-4 w-4" />
        </span>
        {title}
      </h3>
      {children}
    </section>
  );
}

// ---- Plan -----------------------------------------------------------------------

function PlanBoard({
  run,
  focusTask,
  onFocusTask,
  hideHeading = false,
}: {
  run: AgentRunDto;
  focusTask: string | null;
  onFocusTask: (id: string) => void;
  hideHeading?: boolean;
}) {
  const groups = AGENT_RUN_PHASES.map((phase) => ({
    phase,
    tasks: run.tasks.filter((task) => task.phase === phase),
  })).filter((group) => group.tasks.length > 0);

  return (
    <div className={hideHeading ? "p-3 pt-4" : "p-4"}>
      {hideHeading ? null : (
        <h3 className="mb-3 flex items-center gap-2 font-semibold text-sm">
          <ListChecks className="h-4 w-4 text-muted-foreground" />
          Plan
        </h3>
      )}

      {groups.length === 0 ? (
        <div className="space-y-2">
          {run.status === "planning" ? (
            <>
              {[0, 1, 2, 3].map((index) => (
                <div
                  key={index}
                  className="h-12 animate-pulse rounded-lg bg-muted/60"
                  style={{ animationDelay: `${index * 150}ms` }}
                />
              ))}
              <p className="pt-1 text-center text-muted-foreground text-xs">
                The agent is reading your project to draft a plan.
              </p>
            </>
          ) : (
            <p className="text-muted-foreground text-xs">No plan was made.</p>
          )}
        </div>
      ) : (
        <div className="space-y-5">
          {groups.map((group) => {
            const Icon = PHASE_ICONS[group.phase];
            return (
              <section key={group.phase}>
                <h4 className="mb-1.5 flex items-center gap-1.5 font-medium text-[11px] text-muted-foreground uppercase tracking-wider">
                  <Icon className="h-3 w-3" />
                  {PHASE_INFO[group.phase].label}
                </h4>
                <ol className="space-y-1">
                  {group.tasks.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      focused={focusTask === task.id}
                      onClick={() => onFocusTask(task.id)}
                    />
                  ))}
                </ol>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

const TASK_ICONS: Record<
  AgentRunTaskDto["status"],
  { icon: LucideIcon; className: string }
> = {
  pending: { icon: Circle, className: "text-muted-foreground/50" },
  in_progress: { icon: Loader2, className: "animate-spin text-sky-500" },
  done: { icon: CheckCircle2, className: "text-emerald-600" },
  failed: { icon: XCircle, className: "text-destructive" },
  skipped: { icon: SkipForward, className: "text-muted-foreground" },
};

function TaskRow({
  task,
  focused,
  onClick,
}: {
  task: AgentRunTaskDto;
  focused: boolean;
  onClick: () => void;
}) {
  const { icon: Icon, className } = TASK_ICONS[task.status];
  const active = task.status === "in_progress";

  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        aria-pressed={focused}
        className={`group flex w-full items-start gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors ${
          focused
            ? "border-violet-500/50 bg-violet-500/5"
            : active
              ? "border-sky-500/40 bg-sky-500/5"
              : "border-transparent hover:bg-muted/60"
        }`}
      >
        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${className}`} />
        <span className="min-w-0 flex-1">
          <span
            className={`block text-sm leading-5 ${
              task.status === "done"
                ? "text-muted-foreground"
                : task.status === "pending"
                  ? "text-foreground/80"
                  : "font-medium"
            }`}
          >
            {task.title}
          </span>
          {/* Titles only until a task is opened: a column of summaries was
              the densest text on the page. */}
          {focused && (task.summary || task.detail) ? (
            <span className="mt-1 block whitespace-pre-line text-muted-foreground text-xs">
              {task.summary ?? task.detail}
            </span>
          ) : null}
          {task.attempts > 1 ? (
            <span className="mt-1 inline-block rounded bg-amber-500/10 px-1.5 text-[10px] text-amber-700 dark:text-amber-400">
              attempt {task.attempts}
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
}

// ---- Live activity --------------------------------------------------------------

function LiveActivity({ run }: { run: AgentRunDto }) {
  const current = run.tasks.find((task) => task.status === "in_progress");
  // Actions only, the last few. The model's thoughts are long and change every
  // second; "All" in the activity below keeps the full replies.
  const steps = run.liveSteps
    .filter((step) => step.kind !== "thought")
    .slice(-5);
  const list = useRef<HTMLOListElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: follow the newest step.
  useEffect(() => {
    list.current?.scrollTo({
      top: list.current.scrollHeight,
      behavior: "smooth",
    });
  }, [steps.length]);

  return (
    <section className="relative overflow-hidden rounded-2xl border bg-background shadow-sm">
      <div className="absolute inset-x-0 top-0 h-0.5 animate-pulse bg-gradient-to-r from-violet-500 via-sky-500 to-violet-500" />
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-60" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-sky-500" />
        </span>
        <span className="font-medium text-sm">
          {run.status === "planning"
            ? "Investigating and planning"
            : current
              ? current.title
              : "Working"}
        </span>
        {!run.live ? (
          <span className="ml-auto text-muted-foreground text-xs">
            Waiting for the runner…
          </span>
        ) : null}
      </div>
      {steps.length ? (
        <ol ref={list} className="space-y-1 px-4 py-2.5">
          {steps.map((step, index) => (
            <LiveStep
              // biome-ignore lint/suspicious/noArrayIndexKey: steps only ever append.
              key={index}
              step={step}
              latest={index === steps.length - 1}
            />
          ))}
        </ol>
      ) : (
        <p className="flex items-center gap-2 px-4 py-3 text-muted-foreground text-xs">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Starting a session…
        </p>
      )}
    </section>
  );
}

function LiveStep({ step, latest }: { step: AgentStep; latest: boolean }) {
  if (step.kind === "thought") {
    return (
      <li
        className={`flex gap-2 text-xs transition-opacity ${latest ? "" : "opacity-60"}`}
      >
        <Brain className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-500" />
        <span className="line-clamp-3 text-muted-foreground italic">
          {step.text}
        </span>
      </li>
    );
  }
  return (
    <li
      className={`flex gap-2 text-xs transition-opacity ${latest ? "" : "opacity-60"}`}
    >
      {step.ok ? (
        <Wrench className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
      )}
      <span className={`truncate ${step.ok ? "" : "text-destructive"}`}>
        <span className="font-mono text-[11px] text-muted-foreground">
          {step.tool}
        </span>{" "}
        {step.summary}
      </span>
    </li>
  );
}

// ---- Timeline -------------------------------------------------------------------

const EVENT_STYLE: Record<
  AgentRunEventKind,
  { icon: LucideIcon; className: string }
> = {
  status: { icon: CircleDot, className: "text-muted-foreground" },
  plan: { icon: ListChecks, className: "text-violet-600 dark:text-violet-400" },
  task_started: { icon: Play, className: "text-sky-600 dark:text-sky-400" },
  task_done: { icon: CheckCircle2, className: "text-emerald-600" },
  task_failed: { icon: XCircle, className: "text-destructive" },
  iteration: { icon: Sparkles, className: "text-muted-foreground" },
  commit: { icon: GitCommit, className: "text-foreground" },
  check: { icon: CheckCircle2, className: "text-muted-foreground" },
  decision: {
    icon: Lightbulb,
    className: "text-amber-600 dark:text-amber-400",
  },
  guidance: {
    icon: MessageSquare,
    className: "text-violet-600 dark:text-violet-400",
  },
  question: {
    icon: MessageCircleQuestion,
    className: "text-amber-600 dark:text-amber-400",
  },
  approval: { icon: Hand, className: "text-amber-600 dark:text-amber-400" },
  pull_request: { icon: GitPullRequest, className: "text-emerald-600" },
  error: { icon: AlertCircle, className: "text-destructive" },
};

type TimelineFilter = "highlights" | "all";

function Timeline({
  run,
  focusTask,
  onClearFocus,
}: {
  run: AgentRunDto;
  focusTask: string | null;
  onClearFocus: () => void;
}) {
  const [filter, setFilter] = useState<TimelineFilter>("highlights");
  const focused = run.tasks.find((task) => task.id === focusTask) ?? null;

  const events = useMemo(() => {
    let list = run.events;
    if (focusTask) list = list.filter((event) => event.taskId === focusTask);
    // Iterations are the agent's raw replies: useful when digging, noise otherwise.
    if (filter === "highlights" && !focusTask) {
      list = list.filter((event) => event.kind !== "iteration");
    }
    return [...list].reverse();
  }, [run.events, focusTask, filter]);

  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <h3 className="font-semibold text-sm">Activity</h3>
        {focused ? (
          <button
            type="button"
            onClick={onClearFocus}
            className="inline-flex max-w-[60%] items-center gap-1 truncate rounded-full bg-violet-500/10 px-2 py-0.5 text-violet-700 text-xs hover:bg-violet-500/20 dark:text-violet-300"
          >
            <span className="truncate">{focused.title}</span>
            <XCircle className="h-3 w-3 shrink-0" />
          </button>
        ) : (
          <div className="ml-auto flex items-center rounded-lg border p-0.5">
            {(["highlights", "all"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
                className={`rounded-md px-2 py-0.5 text-xs capitalize ${
                  filter === value
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {value}
              </button>
            ))}
          </div>
        )}
      </div>

      {events.length === 0 ? (
        <p className="rounded-xl border border-dashed px-4 py-6 text-center text-muted-foreground text-xs">
          {focusTask ? "Nothing recorded for this task yet." : "Nothing yet."}
        </p>
      ) : (
        <ol className="relative space-y-1 before:absolute before:top-2 before:bottom-2 before:left-[15px] before:w-px before:bg-border">
          {events.map((event) => (
            <TimelineEvent key={event.id} event={event} />
          ))}
        </ol>
      )}
    </section>
  );
}

function TimelineEvent({ event }: { event: AgentRunEventDto }) {
  const { icon: Icon, className } =
    EVENT_STYLE[event.kind] ?? EVENT_STYLE.status;
  const expandable =
    Boolean(event.body) &&
    (event.kind === "iteration" ||
      event.kind === "decision" ||
      (event.body?.length ?? 0) > 120);
  const [open, setOpen] = useState(false);

  const alternatives = Array.isArray(event.data.alternatives)
    ? (event.data.alternatives as Array<{ option?: string; reason?: string }>)
    : [];
  const url = typeof event.data.url === "string" ? event.data.url : null;

  return (
    <li className="relative flex gap-3 rounded-lg py-1.5 pr-2">
      <span className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border bg-background">
        <Icon className={`h-3.5 w-3.5 ${className}`} />
      </span>
      <div className="min-w-0 flex-1 pt-1">
        <div className="flex items-baseline gap-2">
          {expandable ? (
            <button
              type="button"
              onClick={() => setOpen((value) => !value)}
              className="flex min-w-0 items-center gap-1 text-left font-medium text-sm hover:underline"
              aria-expanded={open}
            >
              {open ? (
                <ChevronDown className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 shrink-0" />
              )}
              <span className="truncate">
                {event.kind === "decision"
                  ? `Decided: ${event.title}`
                  : event.title}
              </span>
            </button>
          ) : (
            <span className="min-w-0 truncate font-medium text-sm">
              {event.title}
            </span>
          )}
          <time
            className="ml-auto shrink-0 text-muted-foreground text-[11px] tabular-nums"
            dateTime={event.createdAt}
          >
            {formatClock(event.createdAt)}
          </time>
        </div>

        {event.body && !expandable ? (
          <p
            className="mt-0.5 truncate text-muted-foreground text-xs"
            title={event.body}
          >
            {event.body}
          </p>
        ) : null}

        {event.body && expandable && open ? (
          <div className="mt-2 rounded-lg border bg-muted/20 p-3 text-sm">
            <AgentMarkdown>{event.body}</AgentMarkdown>
            {alternatives.length ? (
              <div className="mt-2 border-t pt-2">
                <p className="mb-1 font-medium text-muted-foreground text-xs">
                  Rejected
                </p>
                <ul className="space-y-0.5 text-muted-foreground text-xs">
                  {alternatives.map((alt) => (
                    <li key={alt.option}>
                      <span className="font-medium text-foreground/80">
                        {alt.option}
                      </span>
                      {alt.reason ? `: ${alt.reason}` : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}

        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-flex items-center gap-1 text-primary text-xs hover:underline"
          >
            Open on GitHub <ExternalLink className="h-3 w-3" />
          </a>
        ) : null}
      </div>
    </li>
  );
}
