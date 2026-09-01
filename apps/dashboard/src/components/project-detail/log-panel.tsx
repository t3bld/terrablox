"use client";

import { Badge } from "@terrablox/ui/badge";
import { Input } from "@terrablox/ui/input";
import { Skeleton } from "@terrablox/ui/skeleton";
import {
  AlertCircle,
  Bot,
  ExternalLink,
  GitCommit,
  MessageSquare,
  MousePointer2,
  Scale,
  Search,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { TabsNav, tabPanelProps } from "@/components/layout/tabs-nav";
import { PROJECT_AGENT_TOOLS } from "@/lib/agent/tool-catalogue";
import type {
  ProjectDecisionDto,
  ProjectLogDto,
  ProjectLogTurnDto,
  ProjectOperationDto,
} from "@/lib/projects/types";

/**
 * The project's log: what the agent did, and why.
 *
 * Two views of one dataset, because there are two questions and they read in
 * opposite directions. *Trajectory* runs along the turns — what was asked, what the
 * agent thought, which tools it called, what came back — and is the answer to "what
 * happened". *Decisions* runs along the reasons and is the answer to "why does it
 * look like this".
 *
 * A dense list of single lines with a detail panel beside it, rather than a stack of
 * expanded cards. The first version put everything inline and became unreadable at
 * exactly the point it mattered: a turn with twenty-nine operations is one line here
 * and a panel-full when asked.
 */

type LogView = "trajectory" | "decisions";

/** Mutation names to the operation they belong to, so labels match the settings. */
const ACTION_TOOLS: Record<string, string> = {
  "add-module": "add_module",
  "remove-module": "remove_module",
  connect: "connect",
  disconnect: "disconnect",
  "auto-connect": "auto_connect",
  "rename-module": "edit_module",
  "set-argument": "edit_module",
  "set-arguments": "edit_module",
  "add-local": "add_local",
  "remove-local": "remove_local",
  "connect-local": "connect_local",
  "set-local": "edit_local",
  "rename-local": "edit_local",
};

function actionLabel(action: string): string {
  const tool = ACTION_TOOLS[action];
  const operation = tool
    ? PROJECT_AGENT_TOOLS.find((entry) => entry.name === tool)
    : undefined;

  return operation?.label ?? action;
}

function stamp(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();

  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleString(undefined, {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        ...(date.getFullYear() === today.getFullYear()
          ? {}
          : { year: "numeric" }),
      });
}

/**
 * One line of the trajectory.
 *
 * `kind` drives the badge and nothing else; `detail` is what the panel shows when
 * the row is picked. Flattened up front rather than rendered from nested data,
 * because a flat list is what can be filtered, counted and keyboard-navigated
 * without every consumer re-deriving the same order.
 */
interface Row {
  id: string;
  kind: "prompt" | "thought" | "tool" | "reply" | "canvas";
  /** Uppercase badge text: `USER`, `THOUGHT`, the tool name, `CANVAS`. */
  badge: string;
  /** The single line shown in the list. */
  line: string;
  /** Turn label for the gutter, on the first row of each turn only. */
  turnLabel?: string;
  ok: boolean;
  turn: ProjectLogTurnDto;
}

/**
 * Turns to rows, newest turn first and chronological within each turn.
 *
 * Newest first because a log is read from the top for what just happened; forward
 * within a turn because a turn is a story — the prompt, then the work, then the
 * answer — and reversing it would make every turn read backwards.
 */
function toRows(turns: ProjectLogTurnDto[]): Row[] {
  const rows: Row[] = [];
  // Numbered from the oldest, so a turn keeps its number as newer ones arrive.
  const numberOf = new Map<string, number>();
  let counter = 0;
  for (const turn of [...turns].reverse()) {
    if (turn.chatMessageId) numberOf.set(turn.chatMessageId, ++counter);
  }

  for (const turn of turns) {
    const key = turn.chatMessageId ?? turn.createdAt;
    const label = turn.chatMessageId
      ? `Turn ${numberOf.get(turn.chatMessageId)}`
      : undefined;
    let first = true;
    const gutter = () => {
      if (!first) return undefined;
      first = false;
      return label;
    };

    if (!turn.chatMessageId) {
      const operation = turn.operations[0];
      rows.push({
        id: `${key}-canvas`,
        kind: "canvas",
        badge: "canvas",
        line: operation?.summary ?? "Change",
        ok: true,
        turn,
      });
      continue;
    }

    if (turn.prompt !== null) {
      rows.push({
        id: `${key}-prompt`,
        kind: "prompt",
        badge: "user",
        line: turn.prompt,
        turnLabel: gutter(),
        ok: true,
        turn,
      });
    }

    for (const [index, step] of turn.steps.entries()) {
      rows.push(
        step.kind === "thought"
          ? {
              id: `${key}-s${index}`,
              kind: "thought",
              badge: "thought",
              line: step.text,
              turnLabel: gutter(),
              ok: true,
              turn,
            }
          : {
              id: `${key}-s${index}`,
              kind: "tool",
              badge: step.tool,
              line: step.summary,
              turnLabel: gutter(),
              ok: step.ok,
              turn,
            },
      );
    }

    rows.push({
      id: `${key}-reply`,
      kind: "reply",
      badge: "reply",
      line: turn.reply ?? "",
      turnLabel: gutter(),
      ok: true,
      turn,
    });
  }

  return rows;
}

const BADGE_TONE: Record<Row["kind"], string> = {
  prompt: "bg-primary/10 text-primary",
  thought: "bg-muted text-muted-foreground",
  tool: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  reply: "bg-muted text-foreground",
  canvas: "bg-muted text-muted-foreground",
};

function RowLine({
  row,
  selected,
  onSelect,
}: {
  row: Row;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      className={`flex w-full items-baseline gap-2 border-b px-3 py-1 text-left text-sm hover:bg-accent/50 ${
        selected ? "bg-accent" : ""
      }`}
      onClick={onSelect}
      type="button"
    >
      {/* A fixed gutter so the badges line up into a column that can be scanned
          rather than read. */}
      <span className="w-14 shrink-0 text-right text-[10px] text-muted-foreground">
        {row.turnLabel}
      </span>
      <span
        className={`w-28 shrink-0 truncate rounded px-1.5 py-0.5 font-medium text-[10px] uppercase tracking-wide ${
          row.ok ? BADGE_TONE[row.kind] : "bg-destructive/15 text-destructive"
        }`}
        title={row.badge}
      >
        {row.badge.replace(/_/g, " ")}
      </span>
      {/* One line, always. The full text is one click away, and a list whose rows
          are different heights cannot be scanned. */}
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {row.line.replace(/\s+/g, " ")}
      </span>
    </button>
  );
}

function PanelSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-1">
      <h4 className="font-semibold text-[11px] text-muted-foreground uppercase tracking-wide">
        {title}
      </h4>
      {children}
    </section>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[6rem_1fr] gap-2 py-0.5 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 [overflow-wrap:anywhere]">{value}</dd>
    </div>
  );
}

function OperationList({
  operations,
  repo,
}: {
  operations: ProjectOperationDto[];
  repo: string | null;
}) {
  return (
    <ol className="divide-y rounded-md border">
      {operations.map((operation) => (
        <li
          className="flex items-baseline gap-2 px-2 py-1 text-xs"
          key={operation.id}
        >
          <Badge className="shrink-0 text-[10px]" variant="outline">
            {actionLabel(operation.action)}
          </Badge>
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            {operation.summary}
          </span>
          {operation.commitSha && repo ? (
            <a
              className="flex shrink-0 items-center gap-1 font-mono text-muted-foreground hover:text-foreground"
              href={`https://github.com/${repo}/commit/${operation.commitSha}`}
              rel="noreferrer"
              target="_blank"
            >
              <GitCommit className="h-3 w-3" />
              {operation.commitSha.slice(0, 7)}
              <ExternalLink className="h-3 w-3" />
            </a>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/** What a picked trajectory row shows: the full text, then the turn around it. */
function RowDetail({
  row,
  repo,
  decision,
  onShowDecision,
}: {
  row: Row;
  repo: string | null;
  decision: ProjectDecisionDto | null;
  onShowDecision: () => void;
}) {
  const { turn } = row;
  const thoughts = turn.steps.filter((step) => step.kind === "thought").length;
  const calls = turn.steps.length - thoughts;

  return (
    <div className="space-y-4">
      <PanelSection title={row.badge.replace(/_/g, " ")}>
        <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">
          {row.line || "(empty)"}
        </p>
      </PanelSection>

      {/* Every row shows the turn it belongs to. A trajectory line on its own is
          rarely the answer — the question is almost always what that line was part
          of. */}
      <PanelSection title="This turn">
        <dl>
          {turn.prompt ? <Meta label="Asked" value={turn.prompt} /> : null}
          <Meta label="At" value={new Date(turn.createdAt).toLocaleString()} />
          <Meta
            label="Trail"
            value={`${calls} tool call${calls === 1 ? "" : "s"}, ${thoughts} reasoning step${thoughts === 1 ? "" : "s"}`}
          />
          <Meta
            label="Changed"
            value={`${turn.operations.length} operation${
              turn.operations.length === 1 ? "" : "s"
            }, ${turn.commits.length} commit${turn.commits.length === 1 ? "" : "s"}`}
          />
        </dl>
      </PanelSection>

      {turn.reply && row.kind !== "reply" ? (
        <PanelSection title="Answer">
          <p className="whitespace-pre-wrap text-muted-foreground text-xs [overflow-wrap:anywhere]">
            {turn.reply}
          </p>
        </PanelSection>
      ) : null}

      {decision ? (
        <PanelSection title="Under decision">
          <button
            className="flex w-full items-start gap-2 rounded-md border p-2 text-left text-xs hover:bg-accent"
            onClick={onShowDecision}
            type="button"
          >
            <Scale className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
              {decision.question} → {decision.choice}
            </span>
          </button>
        </PanelSection>
      ) : null}

      {turn.operations.length ? (
        <PanelSection title={`Operations (${turn.operations.length})`}>
          <OperationList operations={turn.operations} repo={repo} />
        </PanelSection>
      ) : null}
    </div>
  );
}

/** What a picked decision shows: the record, then what it produced. */
function DecisionDetail({
  decision,
  turns,
  repo,
}: {
  decision: ProjectDecisionDto;
  turns: ProjectLogTurnDto[];
  repo: string | null;
}) {
  const operations = turns.flatMap((turn) => turn.operations);

  return (
    <div className="space-y-4">
      <PanelSection title="Decided">
        <p className="text-sm [overflow-wrap:anywhere]">{decision.choice}</p>
      </PanelSection>

      <PanelSection title="Because">
        <p className="text-xs [overflow-wrap:anywhere]">{decision.reason}</p>
      </PanelSection>

      {/* Before the alternatives on purpose: this is the agent's reading of the
          requirements, and the place a misunderstanding is cheapest to catch. */}
      <PanelSection title="Requirements it worked from">
        <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">
          {decision.context}
        </p>
      </PanelSection>

      {decision.alternatives.length ? (
        <PanelSection title="Ruled out">
          <ul className="space-y-1 text-xs">
            {decision.alternatives.map((alternative) => (
              <li className="[overflow-wrap:anywhere]" key={alternative.option}>
                <span className="font-medium">{alternative.option}</span>
                {alternative.reason ? (
                  <span className="text-muted-foreground">
                    {" "}
                    — {alternative.reason}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </PanelSection>
      ) : null}

      {decision.plan.modules.length || decision.plan.wiring.length ? (
        <PanelSection title="Planned">
          <div className="space-y-0.5 rounded-md bg-muted/40 p-2 font-mono text-[11px] text-muted-foreground">
            {decision.plan.modules.map((module) => (
              <p key={`${module.moduleId}-${module.name ?? ""}`}>
                + {module.name ?? module.moduleId}
                {module.purpose ? ` — ${module.purpose}` : ""}
              </p>
            ))}
            {decision.plan.wiring.map((wire) => (
              <p key={`${wire.target}.${wire.targetInput}`}>
                → {wire.target}.{wire.targetInput} ={" "}
                {wire.source
                  ? `${wire.source}.${wire.sourceOutput ?? "?"}`
                  : "(to decide)"}
              </p>
            ))}
          </div>
        </PanelSection>
      ) : null}

      <PanelSection title="Carried out by">
        {turns.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            Nothing built under it yet.
          </p>
        ) : (
          <dl>
            <Meta
              label="Turns"
              value={turns
                .map((turn) => turn.prompt ?? "(no prompt)")
                .join(" · ")}
            />
            <Meta
              label="Changed"
              value={`${operations.length} operation${operations.length === 1 ? "" : "s"}`}
            />
          </dl>
        )}
      </PanelSection>

      {operations.length ? (
        <OperationList operations={operations} repo={repo} />
      ) : null}

      <PanelSection title="Record">
        <dl>
          <Meta
            label="Recorded"
            value={`${decision.origin === "agent" ? "by the agent" : "by you"}, ${new Date(decision.createdAt).toLocaleString()}`}
          />
          <Meta
            label="Status"
            value={
              decision.status === "superseded"
                ? "superseded by a later decision"
                : "in force"
            }
          />
        </dl>
      </PanelSection>
    </div>
  );
}

export function LogPanel({ projectId }: { projectId: string }) {
  const [log, setLog] = useState<ProjectLogDto | null>(null);
  const [repo, setRepo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<LogView>("trajectory");
  const [query, setQuery] = useState("");
  const [selectedRow, setSelectedRow] = useState<string | null>(null);
  const [selectedDecision, setSelectedDecision] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch(`/api/projects/${projectId}/log`);
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(body?.error ?? `Request failed (${response.status})`);
    }
    return body as { log: ProjectLogDto; repoFullName: string };
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;

    load()
      .then((body) => {
        if (cancelled) return;
        setLog(body.log);
        setRepo(body.repoFullName);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Could not load the log.",
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [load]);

  const rows = useMemo(() => toRows(log?.turns ?? []), [log]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(
      (row) =>
        row.badge.toLowerCase().includes(needle) ||
        row.line.toLowerCase().includes(needle),
    );
  }, [rows, query]);

  const decisions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const all = log?.decisions ?? [];
    if (!needle) return all;
    return all.filter((decision) =>
      [decision.question, decision.choice, decision.reason, decision.context]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [log, query]);

  const row = filtered.find((entry) => entry.id === selectedRow) ?? null;
  const decision =
    (log?.decisions ?? []).find((entry) => entry.id === selectedDecision) ??
    null;

  /** The turns filed under the picked decision, for its detail panel. */
  const decisionTurns = useMemo(
    () =>
      decision
        ? (log?.turns ?? []).filter((turn) => turn.decisionId === decision.id)
        : [],
    [decision, log],
  );

  if (error) {
    return (
      <p className="flex items-center gap-2 p-6 text-sm text-destructive">
        <AlertCircle className="h-4 w-4 shrink-0" />
        {error}
      </p>
    );
  }

  if (!log) return <Skeleton className="m-6 h-64" />;

  const showDecision = (id: string) => {
    setSelectedDecision(id);
    setView("decisions");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TabsNav
        idPrefix="log"
        label="Log views"
        onChange={setView}
        tabs={[
          {
            value: "trajectory",
            label: "Trajectory",
            icon: MessageSquare,
            count: log.turns.length,
          },
          {
            value: "decisions",
            label: "Decisions",
            icon: Scale,
            count: log.decisions.length,
          },
        ]}
        value={view}
      />

      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <Input
          className="h-7 max-w-xs border-none text-xs shadow-none focus-visible:ring-0"
          onChange={(event) => setQuery(event.target.value)}
          placeholder={
            view === "trajectory" ? "Filter the trajectory" : "Filter decisions"
          }
          value={query}
        />
        <span className="ml-auto shrink-0 text-muted-foreground text-xs tabular-nums">
          {view === "trajectory"
            ? `${filtered.length} of ${rows.length} entries`
            : `${decisions.length} of ${log.decisions.length} decisions`}
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* The list scrolls on its own so the detail panel stays put while walking
            down it — the reason this is a column beside the list and not a sheet
            over it. */}
        <div
          {...tabPanelProps("log", view)}
          className="min-w-0 flex-1 overflow-y-auto"
        >
          {view === "trajectory" ? (
            filtered.length === 0 ? (
              <Empty query={query} />
            ) : (
              <ol>
                {filtered.map((entry) => (
                  <li key={entry.id}>
                    <RowLine
                      onSelect={() => {
                        setSelectedRow(entry.id);
                        setSelectedDecision(null);
                      }}
                      row={entry}
                      selected={entry.id === selectedRow}
                    />
                  </li>
                ))}
              </ol>
            )
          ) : decisions.length === 0 ? (
            <Empty query={query} />
          ) : (
            <ol>
              {decisions.map((entry) => (
                <li key={entry.id}>
                  <button
                    className={`flex w-full items-baseline gap-2 border-b px-3 py-1.5 text-left text-sm hover:bg-accent/50 ${
                      entry.id === selectedDecision ? "bg-accent" : ""
                    }`}
                    onClick={() => showDecision(entry.id)}
                    type="button"
                  >
                    <span
                      className={`w-28 shrink-0 truncate rounded px-1.5 py-0.5 font-medium text-[10px] uppercase tracking-wide ${
                        entry.status === "superseded"
                          ? "bg-muted text-muted-foreground"
                          : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                      }`}
                    >
                      {entry.status === "superseded"
                        ? "superseded"
                        : "in force"}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {entry.question}
                      <span className="text-muted-foreground">
                        {" → "}
                        {entry.choice}
                      </span>
                    </span>
                    <span className="shrink-0 text-muted-foreground text-xs">
                      {stamp(entry.createdAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>

        <aside
          aria-label="Details"
          className="hidden w-96 shrink-0 overflow-y-auto border-l bg-card p-4 lg:block"
        >
          {view === "trajectory" && row ? (
            <RowDetail
              decision={
                (log.decisions ?? []).find(
                  (entry) => entry.id === row.turn.decisionId,
                ) ?? null
              }
              onShowDecision={() => {
                if (row.turn.decisionId) showDecision(row.turn.decisionId);
              }}
              repo={repo}
              row={row}
            />
          ) : view === "decisions" && decision ? (
            <DecisionDetail
              decision={decision}
              repo={repo}
              turns={decisionTurns}
            />
          ) : (
            <p className="flex items-start gap-2 text-muted-foreground text-xs">
              {view === "trajectory" ? (
                <Wrench className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              ) : (
                <Scale className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              )}
              {view === "trajectory"
                ? "Pick a line to see it in full, and what the turn around it did."
                : "Pick a decision to see the requirements it worked from and the edits it produced."}
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}

function Empty({ query }: { query: string }) {
  return (
    <p className="p-6 text-center text-muted-foreground text-sm">
      {query ? (
        <>Nothing matches “{query}”.</>
      ) : (
        <span className="flex flex-col items-center gap-2">
          <Bot className="h-6 w-6" />
          Nothing yet. Ask the agent for something and its decisions, its
          reasoning and every edit it makes land here.
          <span className="flex items-center gap-1 text-xs">
            <MousePointer2 className="h-3 w-3" />
            Canvas edits appear too, without a decision behind them.
          </span>
        </span>
      )}
    </p>
  );
}
