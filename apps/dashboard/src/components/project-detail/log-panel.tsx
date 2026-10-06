"use client";

import { PROJECT_AGENT_TOOLS } from "@terrablox/agent-harness/tool-catalogue";
import { Badge } from "@terrablox/ui/badge";
import { Input } from "@terrablox/ui/input";
import { Skeleton } from "@terrablox/ui/skeleton";
import { TabsNav, tabPanelProps } from "@terrablox/ui/tabs-nav";
import {
  AlertCircle,
  Bot,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  GitCommit,
  MessageSquare,
  MousePointer2,
  Scale,
  Search,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  filterGroups,
  type Row,
  type TurnGroup,
  toGroups,
} from "@/lib/projects/log-view";
import type {
  ProjectDecisionDto,
  ProjectLogDto,
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
      className={`flex w-full items-baseline gap-2 border-b py-1 pr-3 pl-10 text-left text-sm hover:bg-accent/50 ${
        selected ? "bg-accent" : ""
      }`}
      onClick={onSelect}
      type="button"
    >
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

/**
 * One turn, collapsed: what was asked, and what it cost.
 *
 * Two controls in one row, which is deliberate and is the only fiddly part of this
 * component. The chevron expands the turn; everything else selects it and fills the
 * panel. They are separate because they answer different questions — "show me the
 * steps" and "tell me everything about this turn" — and a single click doing both
 * meant you could not read a turn's summary without also unfolding thirty lines.
 */
function TurnRow({
  expanded,
  group,
  onSelect,
  onToggle,
  selected,
}: {
  expanded: boolean;
  group: TurnGroup;
  onSelect: () => void;
  onToggle: () => void;
  selected: boolean;
}) {
  const { turn } = group;
  const counts = [
    group.calls ? `${group.calls} call${group.calls === 1 ? "" : "s"}` : null,
    turn.operations.length
      ? `${turn.operations.length} op${turn.operations.length === 1 ? "" : "s"}`
      : null,
  ].filter(Boolean);

  return (
    <div
      className={`flex items-center border-b text-sm ${
        selected ? "bg-accent" : "hover:bg-accent/50"
      }`}
    >
      {group.canvas ? (
        // A canvas gesture is one operation with nothing behind it — no prompt, no
        // trail. An empty disclosure would promise something to unfold.
        <span className="w-8 shrink-0" />
      ) : (
        <button
          aria-expanded={expanded}
          aria-label={
            expanded
              ? `Collapse ${group.label ?? "the turn"}`
              : `Expand ${group.label ?? "the turn"}`
          }
          className="flex w-8 shrink-0 items-center justify-center self-stretch text-muted-foreground hover:text-foreground"
          onClick={onToggle}
          type="button"
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>
      )}

      <button
        className="flex min-w-0 flex-1 items-baseline gap-2 py-1.5 pr-3 text-left"
        onClick={onSelect}
        type="button"
      >
        <span className="w-14 shrink-0 truncate text-[10px] text-muted-foreground">
          {group.label ?? "canvas"}
        </span>
        <span className="min-w-0 flex-1 truncate">
          {group.canvas
            ? group.rows[0]?.line
            : (turn.prompt ?? (
                <span className="text-muted-foreground">(no prompt)</span>
              ))}
        </span>
        {group.failed ? (
          <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
        ) : null}
        {counts.length ? (
          <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
            {counts.join(" · ")}
          </span>
        ) : null}
        <span className="w-16 shrink-0 text-right text-muted-foreground text-xs">
          {stamp(turn.createdAt)}
        </span>
      </button>
    </div>
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

/**
 * A whole turn, for the panel: the question, the answer, every step, every change.
 *
 * The turn's own view, not a row's. Picking the turn is how you ask "what happened
 * here" without unfolding it, so this has to answer that completely — which means
 * the trail is written out in full rather than counted, and the counts in the header
 * exist to tell you whether it is worth opening.
 */
function TurnDetail({
  decision,
  group,
  onShowDecision,
  repo,
}: {
  decision: ProjectDecisionDto | null;
  group: TurnGroup;
  onShowDecision: () => void;
  repo: string | null;
}) {
  const { turn } = group;

  return (
    <div className="space-y-4">
      <PanelSection title={group.label ?? "Canvas change"}>
        <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">
          {group.canvas
            ? (group.rows[0]?.line ?? "Change")
            : (turn.prompt ?? "(no prompt)")}
        </p>
      </PanelSection>

      <PanelSection title="At a glance">
        <dl>
          <Meta label="At" value={new Date(turn.createdAt).toLocaleString()} />
          {group.canvas ? null : (
            <Meta
              label="Trail"
              value={`${group.calls} tool call${group.calls === 1 ? "" : "s"}, ${group.thoughts} reasoning step${group.thoughts === 1 ? "" : "s"}`}
            />
          )}
          <Meta
            label="Changed"
            value={`${turn.operations.length} operation${
              turn.operations.length === 1 ? "" : "s"
            }, ${turn.commits.length} commit${turn.commits.length === 1 ? "" : "s"}`}
          />
        </dl>
      </PanelSection>

      {turn.reply ? (
        <PanelSection title="Answer">
          <p className="whitespace-pre-wrap text-xs [overflow-wrap:anywhere]">
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

      {/* In full, because this is the only place it is written out — the list shows
          it only when the turn is unfolded, and the question this panel answers is
          what the agent did rather than which line you clicked. */}
      {turn.steps.length ? (
        <PanelSection title={`Trail (${turn.steps.length})`}>
          <ol className="divide-y rounded-md border">
            {turn.steps.map((step, index) => (
              <li
                className="flex items-baseline gap-2 px-2 py-1 text-xs"
                key={`${group.key}-step-${index}`}
              >
                <span
                  className={`w-20 shrink-0 truncate rounded px-1 py-0.5 font-medium text-[10px] uppercase tracking-wide ${
                    step.kind === "thought"
                      ? BADGE_TONE.thought
                      : step.ok
                        ? BADGE_TONE.tool
                        : "bg-destructive/15 text-destructive"
                  }`}
                  title={step.kind === "thought" ? "thought" : step.tool}
                >
                  {(step.kind === "thought" ? "thought" : step.tool).replace(
                    /_/g,
                    " ",
                  )}
                </span>
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                  {step.kind === "thought" ? step.text : step.summary}
                </span>
              </li>
            ))}
          </ol>
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
  groups,
  onShowTurn,
  repo,
}: {
  decision: ProjectDecisionDto;
  /** The turns filed under this decision, as the trajectory groups them. */
  groups: TurnGroup[];
  onShowTurn: (key: string) => void;
  repo: string | null;
}) {
  const operations = groups.flatMap((group) => group.turn.operations);

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

      {/* The turns, as rows that go there, rather than their prompts joined with a
          separator. This is the one link that used to be missing: a decision could
          be read from a turn but never the other way round, so "what did this
          decision actually produce" ended in a sentence you had to go and search
          for. */}
      <PanelSection title={`Carried out by (${groups.length})`}>
        {groups.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            Nothing built under it yet.
          </p>
        ) : (
          <>
            <ol className="divide-y rounded-md border">
              {groups.map((group) => (
                <li key={group.key}>
                  <button
                    className="flex w-full items-baseline gap-2 px-2 py-1 text-left text-xs hover:bg-accent"
                    onClick={() => onShowTurn(group.key)}
                    type="button"
                  >
                    <span className="w-12 shrink-0 text-[10px] text-muted-foreground">
                      {group.label ?? "canvas"}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {group.turn.prompt ?? "(no prompt)"}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                      {group.turn.operations.length
                        ? `${group.turn.operations.length} ops`
                        : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
            <dl>
              <Meta
                label="Changed"
                value={`${operations.length} operation${operations.length === 1 ? "" : "s"}`}
              />
            </dl>
          </>
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
  /**
   * What the panel is showing: a whole turn, or one line inside one.
   *
   * One field rather than two booleans, so the two cannot both be set — the panel
   * has one slot and a state that allowed both would have to pick a winner
   * somewhere further down.
   */
  const [picked, setPicked] = useState<{
    kind: "turn" | "row";
    id: string;
  } | null>(null);
  /** Turn keys the reader has unfolded. Collapsed is the default for all of them. */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
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

  const groups = useMemo(() => toGroups(log?.turns ?? []), [log]);

  /**
   * Groups that match the filter, with their non-matching lines dropped.
   *
   * A search has to be able to reach inside a collapsed turn, or the filter would
   * only ever find the prompts. So a turn survives if its prompt matches or any of
   * its lines does, and what is left of it is the lines that did — which is also
   * what makes the auto-expansion below honest rather than noisy.
   */
  const filtered = useMemo(() => filterGroups(groups, query), [groups, query]);

  /**
   * Searching unfolds what it found.
   *
   * Without this a filter would leave a list of collapsed headers and no sign of
   * why any of them matched. Only while a query is set, and it does not survive
   * clearing it — so the reader's own folding is not overwritten permanently.
   */
  const showAll = query.trim().length > 0;

  const totalRows = useMemo(
    () => groups.reduce((sum, group) => sum + group.rows.length, 0),
    [groups],
  );
  const shownRows = useMemo(
    () => filtered.reduce((sum, group) => sum + group.rows.length, 0),
    [filtered],
  );

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

  const pickedGroup =
    picked?.kind === "turn"
      ? (groups.find((group) => group.key === picked.id) ?? null)
      : null;
  const row =
    picked?.kind === "row"
      ? (groups
          .flatMap((group) => group.rows)
          .find((entry) => entry.id === picked.id) ?? null)
      : null;
  const decision =
    (log?.decisions ?? []).find((entry) => entry.id === selectedDecision) ??
    null;

  /** The turns filed under the picked decision, for its detail panel. */
  const decisionGroups = useMemo(
    () =>
      decision
        ? groups.filter((group) => group.turn.decisionId === decision.id)
        : [],
    [decision, groups],
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

  /**
   * Jumps from a decision to a turn it produced.
   *
   * Unfolds it as well as selecting it: arriving at a collapsed header from
   * somewhere else shows a single line and hides the very steps that were the reason
   * for following the link. The query is cleared for the same reason — a filter left
   * over from the decisions list would very likely hide the turn just asked for.
   */
  const showTurn = (key: string) => {
    setQuery("");
    setPicked({ kind: "turn", id: key });
    setExpanded((current) => new Set(current).add(key));
    setView("trajectory");
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
            ? `${filtered.length} of ${groups.length} turns, ${shownRows} of ${totalRows} entries`
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
                {filtered.map((group) => {
                  const open = showAll || expanded.has(group.key);

                  return (
                    <li key={group.key}>
                      <TurnRow
                        expanded={open}
                        group={group}
                        onSelect={() => {
                          setPicked({ kind: "turn", id: group.key });
                          setSelectedDecision(null);
                        }}
                        onToggle={() =>
                          setExpanded((current) => {
                            const next = new Set(current);
                            if (next.has(group.key)) next.delete(group.key);
                            else next.add(group.key);
                            return next;
                          })
                        }
                        selected={
                          picked?.kind === "turn" && picked.id === group.key
                        }
                      />

                      {/* Only when unfolded, and never for a canvas change: its one
                          line is already the header. */}
                      {open && !group.canvas ? (
                        <ol>
                          {group.rows.map((entry) => (
                            <li key={entry.id}>
                              <RowLine
                                onSelect={() => {
                                  setPicked({ kind: "row", id: entry.id });
                                  setSelectedDecision(null);
                                }}
                                row={entry}
                                selected={
                                  picked?.kind === "row" &&
                                  picked.id === entry.id
                                }
                              />
                            </li>
                          ))}
                        </ol>
                      ) : null}
                    </li>
                  );
                })}
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
          {view === "trajectory" && pickedGroup ? (
            <TurnDetail
              decision={
                (log.decisions ?? []).find(
                  (entry) => entry.id === pickedGroup.turn.decisionId,
                ) ?? null
              }
              group={pickedGroup}
              onShowDecision={() => {
                if (pickedGroup.turn.decisionId) {
                  showDecision(pickedGroup.turn.decisionId);
                }
              }}
              repo={repo}
            />
          ) : view === "trajectory" && row ? (
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
              groups={decisionGroups}
              onShowTurn={showTurn}
              repo={repo}
            />
          ) : (
            <p className="flex items-start gap-2 text-muted-foreground text-xs">
              {view === "trajectory" ? (
                <Wrench className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              ) : (
                <Scale className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              )}
              {view === "trajectory"
                ? "Pick a turn to see everything it did, or unfold it and pick one line."
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
