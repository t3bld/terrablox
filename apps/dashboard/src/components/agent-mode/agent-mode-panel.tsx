"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@terrablox/ui/dialog";
import { Skeleton } from "@terrablox/ui/skeleton";
import { useToast } from "@terrablox/ui/toast";
import { ChevronRight, GitPullRequest, History } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AgentHarness } from "@/components/agent/agent-harness";
import type {
  AgentRunAction,
  AgentRunDto,
  AgentRunSources,
  AgentRunSummaryDto,
} from "@/lib/agent-runs/types";
import type { ProjectGraph } from "@/lib/projects/types";
import { MissionComposer, type MissionStart } from "./mission-composer";
import {
  formatRelative,
  isFinished,
  isWorking,
  needsUser,
  STATUS_META,
} from "./run-ui";
import { RunView } from "./run-view";

/** While the agent works: matches the rate the runner writes its trail at. */
const POLL_WORKING_MS = 2_000;
/** While it waits for someone: slow, in case another tab acts on it. */
const POLL_WAITING_MS = 8_000;

/**
 * The response body, or an error that says what went wrong.
 *
 * A route that crashes in development answers with Next's HTML error page, and
 * `res.json()` on that surfaces as "Unexpected token '<'", which tells nobody
 * anything.
 */
// biome-ignore lint/suspicious/noExplicitAny: callers read fields they check themselves.
async function readBody(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `The server answered with an error page (HTTP ${res.status}). Check the dashboard logs.`,
    );
  }
}

/** What the surrounding window shows on its Agent switch. */
export type AgentAttention = "working" | "waiting" | null;

interface AgentModePanelProps {
  projectId: string;
  /** Laid out for a narrow window rather than a page. */
  compact?: boolean;
  /** Told whenever the open mission starts or stops needing a look. */
  onAttention?: (attention: AgentAttention) => void;
  /** Called with the fresh graph after the agent committed, so the canvas follows. */
  onGraphChanged?: (graph: ProjectGraph) => void;
}

/**
 * The Agent tab.
 *
 * Self-contained on purpose: it owns its data and talks only to the agent-run
 * API, so the rest of the project page (canvas, chat, deploy) works exactly as it
 * did before this tab existed.
 */
export function AgentModePanel({
  projectId,
  compact = false,
  onAttention,
  onGraphChanged,
}: AgentModePanelProps) {
  const toast = useToast();
  const [runs, setRuns] = useState<AgentRunSummaryDto[] | null>(null);
  const [sources, setSources] = useState<AgentRunSources | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [run, setRun] = useState<AgentRunDto | null>(null);
  const [starting, setStarting] = useState(false);
  const [acting, setActing] = useState<AgentRunAction["action"] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Bumped to restart the poll after an action changed the run. */
  const [pollKey, setPollKey] = useState(0);
  /** Opened an open run automatically once, so "back" does not bounce. */
  const autoOpened = useRef(false);

  const loadRuns = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/agent-runs`);
      const body = await readBody(res);
      if (!res.ok) throw new Error(body?.error ?? "Could not load missions");
      setRuns(body.runs as AgentRunSummaryDto[]);
      setSources(body.sources as AgentRunSources);
      setLoadError(null);
      return body.runs as AgentRunSummaryDto[];
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : "Could not load missions",
      );
      return null;
    }
  }, [projectId]);

  useEffect(() => {
    void loadRuns().then((loaded) => {
      // A mission still in flight is what the user came back for.
      const open = loaded?.find((entry) => !isFinished(entry.status));
      if (open && !autoOpened.current) {
        autoOpened.current = true;
        setSelectedId(open.id);
      }
    });
  }, [loadRuns]);

  const refreshGraph = useCallback(async () => {
    if (!onGraphChanged) return;
    try {
      const res = await fetch(`/api/projects/${projectId}/graph`);
      const body = await readBody(res);
      if (res.ok && body?.graph) onGraphChanged(body.graph as ProjectGraph);
    } catch {
      // The canvas catches up on the next load; not worth interrupting for.
    }
  }, [projectId, onGraphChanged]);

  // The selected run, polled at a rate that depends on what it is doing.
  useEffect(() => {
    if (!selectedId) {
      setRun(null);
      return;
    }
    void pollKey;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastStatus: string | null = null;
    let lastCommits: number | null = null;

    const tick = async () => {
      try {
        const res = await fetch(
          `/api/projects/${projectId}/agent-runs/${selectedId}`,
        );
        const body = await readBody(res);
        if (!res.ok) throw new Error(body?.error ?? "Could not load the run");
        if (cancelled) return;

        const next = body.run as AgentRunDto;
        setRun(next);

        // The list shows status and progress, so it follows status changes.
        if (lastStatus !== null && lastStatus !== next.status) void loadRuns();
        lastStatus = next.status;

        // The agent commits to the project branch, so the canvas redraws from
        // the repository whenever a step pushed something.
        if (lastCommits !== null && next.commits.length > lastCommits) {
          void refreshGraph();
        }
        lastCommits = next.commits.length;

        const delay = isWorking(next.status)
          ? POLL_WORKING_MS
          : isFinished(next.status)
            ? null
            : POLL_WAITING_MS;
        if (delay !== null) timer = setTimeout(tick, delay);
      } catch (error) {
        if (cancelled) return;
        toast.error(
          error instanceof Error ? error.message : "Could not load the run",
        );
        timer = setTimeout(tick, POLL_WAITING_MS);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // `run` is deliberately not a dependency: the poll owns it. `pollKey` is read
    // above so that bumping it restarts the poll.
  }, [selectedId, projectId, loadRuns, toast, pollKey, refreshGraph]);

  // The selected run is fresher than the list, so it wins when there is one.
  const openSummary = runs?.find((entry) => !isFinished(entry.status)) ?? null;
  const attentionStatus =
    run && !isFinished(run.status) ? run.status : (openSummary?.status ?? null);
  const attention: AgentAttention = attentionStatus
    ? isWorking(attentionStatus)
      ? "working"
      : "waiting"
    : null;

  useEffect(() => {
    onAttention?.(attention);
  }, [attention, onAttention]);

  const start = async (input: MissionStart) => {
    setStarting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/agent-runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const body = await readBody(res);
      if (!res.ok)
        throw new Error(body?.error ?? "Could not start the mission");
      const created = body.run as AgentRunDto;
      setRun(created);
      setSelectedId(created.id);
      void loadRuns();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not start the mission",
      );
    } finally {
      setStarting(false);
    }
  };

  const act = async (action: AgentRunAction) => {
    if (!run) return;
    setActing(action.action);
    try {
      const res = await fetch(
        `/api/projects/${projectId}/agent-runs/${run.id}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(action),
        },
      );
      const body = await readBody(res);
      if (!res.ok) throw new Error(body?.error ?? "That did not work");
      const next = body.run as AgentRunDto;
      setRun(next);
      void loadRuns();

      // Restart the poll at once, at the rate the new status calls for.
      setPollKey((key) => key + 1);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "That did not work");
    } finally {
      setActing(null);
    }
  };

  if (selectedId && run && run.id === selectedId) {
    return (
      <RunView
        run={run}
        acting={acting}
        onAct={(action) => void act(action)}
        onBack={() => setSelectedId(null)}
        compact={compact}
      />
    );
  }

  if (selectedId) {
    return (
      <div className={`flex-1 space-y-4 ${compact ? "p-3" : "p-6"}`}>
        <Skeleton className="h-24 w-full" />
        <div className="flex gap-4">
          {compact ? null : <Skeleton className="h-96 w-80" />}
          <Skeleton className="h-96 flex-1" />
        </div>
      </div>
    );
  }

  const openRun = openSummary;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
      {/* The same project-scoped harness dialog as the chat's: Agent mode runs on
          the same settings, so there is one place to change them. */}
      <Dialog onOpenChange={setSettingsOpen} open={settingsOpen}>
        <DialogContent className="max-h-[92vh] w-[95vw] max-w-6xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Agent Harness</DialogTitle>
          </DialogHeader>
          <AgentHarness projectId={projectId} withHeading={false} />
        </DialogContent>
      </Dialog>

      {openRun ? (
        <button
          type="button"
          onClick={() => setSelectedId(openRun.id)}
          className={`flex w-full items-center gap-3 border-b bg-sky-500/5 py-3 text-left hover:bg-sky-500/10 ${compact ? "px-4" : "px-6"}`}
        >
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${STATUS_META[openRun.status].dot} ${isWorking(openRun.status) ? "animate-pulse" : ""}`}
          />
          <span className="min-w-0 flex-1">
            <span className="block font-medium text-sm">
              {needsUser(openRun.status)
                ? "A mission is waiting for you"
                : "A mission is in progress"}
            </span>
            <span className="block truncate text-muted-foreground text-xs">
              {openRun.title}
            </span>
          </span>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      ) : null}

      <MissionComposer
        sources={sources}
        starting={starting}
        blockedBy={
          openRun
            ? "Finish or stop the mission in progress before starting another."
            : null
        }
        onStart={(input) => void start(input)}
        onOpenSettings={() => setSettingsOpen(true)}
        compact={compact}
      />

      <div
        className={`mx-auto w-full ${compact ? "px-4 pb-6" : "max-w-3xl px-6 pb-12"}`}
      >
        {loadError ? (
          <p className="text-destructive text-sm">{loadError}</p>
        ) : runs === null ? (
          <Skeleton className="h-24 w-full" />
        ) : runs.length ? (
          <RunHistory runs={runs} onOpen={setSelectedId} />
        ) : null}
      </div>
    </div>
  );
}

function RunHistory({
  runs,
  onOpen,
}: {
  runs: AgentRunSummaryDto[];
  onOpen: (id: string) => void;
}) {
  return (
    <section>
      <h3 className="mb-2 flex items-center gap-2 font-medium text-sm">
        <History className="h-4 w-4 text-muted-foreground" />
        Previous missions
      </h3>
      <ul className="divide-y overflow-hidden rounded-xl border">
        {runs.map((entry) => {
          const meta = STATUS_META[entry.status];
          return (
            <li key={entry.id}>
              <button
                type="button"
                onClick={() => onOpen(entry.id)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40"
              >
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${meta.dot} ${isWorking(entry.status) ? "animate-pulse" : ""}`}
                  title={meta.label}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{entry.title}</span>
                  <span className="mt-0.5 flex items-center gap-2 text-muted-foreground text-xs">
                    <span>{meta.label}</span>
                    <span aria-hidden>·</span>
                    <span>{formatRelative(entry.createdAt)}</span>
                    {entry.tasksTotal ? (
                      <>
                        <span aria-hidden>·</span>
                        <span className="tabular-nums">
                          {entry.tasksDone}/{entry.tasksTotal} tasks
                        </span>
                      </>
                    ) : null}
                  </span>
                </span>
                {entry.prUrl ? (
                  <GitPullRequest className="h-4 w-4 shrink-0 text-emerald-600" />
                ) : null}
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
