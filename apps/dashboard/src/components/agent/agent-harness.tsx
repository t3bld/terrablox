"use client";

import {
  anchorLabel,
  groupedElementsOnPlane,
  HARNESS_ENFORCEMENT,
  HARNESS_EXTERNALS,
  HARNESS_PLANES,
  type HarnessElement,
  type HarnessEnforcement,
  type HarnessPlane,
  TURN_ACTORS,
  TURN_AFTER,
  TURN_BEFORE,
  TURN_EXITS,
  TURN_LOOP,
  type TurnStep,
} from "@terrablox/agent-harness/harness-model";
import {
  APP_REPO_FILE_CHARS_MAX,
  APP_REPO_FILE_CHARS_MIN,
  APP_REPO_READS_MAX,
  APP_REPO_READS_MIN,
  APP_REPO_TREE_MAX,
  APP_REPO_TREE_MIN,
  HISTORY_BUDGET_MAX_CHARS,
  HISTORY_BUDGET_MIN_CHARS,
  MCP_CALL_BUDGET_MAX,
  MCP_CALL_BUDGET_MIN,
  REASONING_EFFORTS,
  STEP_TRAIL_MAX,
  STEP_TRAIL_MIN,
  TOOL_CALL_BUDGET_MAX,
  TOOL_CALL_BUDGET_MIN,
  TURN_TIMEOUT_MAX_SECONDS,
  TURN_TIMEOUT_MIN_SECONDS,
} from "@terrablox/agent-harness/runtime-options";
import type { DependencyGraphNode } from "@terrablox/graph/dependency-graph";
import { DependencyGraph } from "@terrablox/graph/dependency-graph";
import { Badge } from "@terrablox/ui/badge";
import { Button } from "@terrablox/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@terrablox/ui/card";
import { InfoHint } from "@terrablox/ui/info-hint";
import { Input } from "@terrablox/ui/input";
import { Label } from "@terrablox/ui/label";
import { Select } from "@terrablox/ui/select";
import { Skeleton } from "@terrablox/ui/skeleton";
import { Textarea } from "@terrablox/ui/textarea";
import { useToast } from "@terrablox/ui/toast";
import { ToggleRow } from "@terrablox/ui/toggle-row";
import { AlertCircle, CornerUpLeft, Repeat } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { GraphDetailPanel } from "@/components/module-detail/graph-detail-panel";
import { AppRepoPicker } from "@/components/projects/app-repo-picker";

import {
  type AgentContextView,
  buildGraph,
  groupToolsByGroup,
  type McpServerRow,
  type McpToolRow,
  THIRD_PARTY,
  TOOL_GROUP_LABELS,
} from "@/lib/agent/harness-graph";

/**
 * The agent's harness, as a diagram and as the settings behind it.
 *
 * One rule holds this file together: every heading on this screen is an element
 * of `harness-model.ts`, and so is every box in the diagram. Neither surface
 * writes its own headings. Before that rule the cards carried hand-written
 * sections — "What the turn runs on", "Limits", "Permission" — that matched no box
 * in the graph, so a reader could see a switch and a diagram and had no way to
 * work out which part of the harness the switch belonged to.
 *
 * The consequence worth knowing when editing: to add a setting you add an element
 * to the model, then teach {@link AgentHarness.controlFor} to render its control.
 * A control with no element cannot be placed, which is the point.
 */

/** Mirrors MAX_INSTRUCTIONS_LENGTH in the settings service. */
const MAX_INSTRUCTIONS = 4000;

interface ModelOption {
  id: string;
  name: string;
  reasoningEfforts: string[];
  multiplier: number | null;
  /** Absent on the fallback list, which holds no previews. */
  preview?: boolean;
}

/**
 * How strong a part of the harness is, said in two words.
 *
 * On the screen because the distinction is the whole point: an operation that is
 * not registered cannot be called, while a sentence in the prompt is a request.
 * Both used to sit in one list called "Guardrails", which flattered the weak ones
 * and hid what the strong ones were doing.
 */
function EnforcementBadge({ kind }: { kind: HarnessEnforcement }) {
  const meta = HARNESS_ENFORCEMENT[kind];

  return (
    <Badge
      className="shrink-0 font-normal"
      title={meta.explanation}
      variant={meta.strength === "enforced" ? "secondary" : "outline"}
    >
      {meta.label}
    </Badge>
  );
}

/**
 * One element of the harness, with its control underneath if it has one.
 *
 * The single place a heading on this screen is produced, and it can only produce
 * `element.label` — which is also the label the diagram draws. That is what makes
 * the two impossible to desynchronise.
 *
 * An element with no control is not skipped. The parts nobody can change are the
 * ones carrying the most weight, and a screen showing only switches would suggest
 * they do not exist; for those the description is the content, so it is printed
 * rather than tucked behind the info icon.
 */
/**
 * A number a user types, with the default as its empty state.
 *
 * A field rather than the picker these settings used to be. The picker was chosen
 * because it cannot be typed wrong and needs no error state, which was true and
 * still cost more than it bought: every value in range is accepted by the API, so
 * the list was only ever a guess at which of them anyone would want, and a number
 * reached by any other route had to be spliced back into the options to stop the
 * dropdown displaying a different budget than the turn enforces. Six of these
 * settings now exist and that guessing does not scale.
 *
 * Empty means "follow the default", which is the same null the API stores, so the
 * inherit case needs no control of its own. The default shows through as the
 * placeholder — visible without being a value the field claims somebody chose.
 *
 * Writes on blur and on Enter rather than on every keystroke: each save reloads the
 * whole context, so saving per keystroke would fire a request per digit and the
 * reload would fight the cursor. Out-of-range input is reported in place and not
 * sent, because the server rejects rather than clamps, and a rejection arriving as
 * a banner over the diagram would not say which field was wrong.
 */
function NumberSetting({
  busy,
  defaultValue,
  describe,
  hint,
  id,
  label,
  max,
  min,
  onSave,
  unit,
  value,
}: {
  busy: boolean;
  defaultValue: number;
  /** Says what a number means where the unit is not the point. 1800 → "30 minutes". */
  describe?: (value: number) => string;
  hint?: React.ReactNode;
  id: string;
  label: string;
  max: number;
  min: number;
  onSave: (value: number | null) => void;
  unit?: string;
  value: number | null;
}) {
  const [draft, setDraft] = useState(value === null ? "" : String(value));
  const [problem, setProblem] = useState<string | null>(null);

  // The stored value wins whenever it changes under the field: a save reloads the
  // context, and the same field is mounted in both scopes with different values.
  useEffect(() => {
    setDraft(value === null ? "" : String(value));
    setProblem(null);
  }, [value]);

  const say = (n: number) =>
    describe ? describe(n) : `${n}${unit ? ` ${unit}` : ""}`;

  const commit = () => {
    const text = draft.trim();

    if (text === "") {
      setProblem(null);
      // Only when it is a change. An empty field that was already inheriting must
      // not send a write every time it loses focus.
      if (value !== null) onSave(null);
      return;
    }

    const next = Number(text);

    if (!Number.isFinite(next) || next < min || next > max) {
      setProblem(`Enter a number between ${min} and ${max}.`);
      return;
    }

    setProblem(null);
    const rounded = Math.round(next);
    if (rounded === value) setDraft(String(rounded));
    else onSave(rounded);
  };

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          className="w-32 tabular-nums"
          disabled={busy}
          id={id}
          inputMode="numeric"
          max={max}
          min={min}
          onBlur={commit}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
          }}
          placeholder={String(defaultValue)}
          type="number"
          value={draft}
        />
        {unit ? (
          <span className="text-muted-foreground text-sm">{unit}</span>
        ) : null}
      </div>
      <p className="text-muted-foreground text-xs">
        {problem ? (
          <span className="text-destructive">{problem}</span>
        ) : draft.trim() === "" ? (
          `Follows the default: ${say(defaultValue)}. Type a number to decide it here.`
        ) : (
          `Clear the field to follow the default (${say(defaultValue)}).`
        )}
      </p>
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
    </div>
  );
}

function ElementRow({
  element,
  scopeBadge,
  children,
}: {
  element: HarnessElement;
  /** Rendered beside the label when a project overrides this setting. */
  scopeBadge?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const fixed = children === null || children === undefined;

  return (
    <div
      className={fixed ? "rounded-md border border-dashed p-3" : "space-y-2"}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium text-sm">{element.label}</span>
        <EnforcementBadge kind={element.enforcement} />
        {scopeBadge}
        <InfoHint label={element.label}>
          {element.description}
          {/* Named so the claim above can be checked in the code rather than
              taken on trust from the screen that makes it. */}
          <span className="mt-2 block font-mono text-[0.7rem] opacity-70">
            {element.source}
          </span>
        </InfoHint>
      </div>

      {fixed ? (
        <p className="text-muted-foreground text-xs">{element.description}</p>
      ) : (
        children
      )}
    </div>
  );
}

/**
 * The planes that hang off this one, named.
 *
 * Read from `attachesTo`, the same field the diagram draws its edges from, so the
 * two cannot disagree about what contains what.
 */
function PlaneChildren({ of }: { of: HarnessPlane }) {
  const children = HARNESS_PLANES.filter((plane) => plane.attachesTo === of);
  if (children.length === 0) return null;

  return (
    <p className="text-muted-foreground text-xs">
      Inside this:{" "}
      {children.map((child, index) => (
        <span key={child.id}>
          {index > 0 ? " · " : ""}
          <span className="font-medium">{child.label}</span>
        </span>
      ))}
      . Each has its own card below and its own box in the diagram.
    </p>
  );
}

/** Who runs a step, in two words, so the loop says whose code turns it. */
function ActorBadge({ actor }: { actor: TurnStep["actor"] }) {
  return (
    <Badge
      className="shrink-0 font-normal"
      // Ours is the one worth picking out: those are the steps where our code can
      // refuse. The other two are the model thinking and the runtime carrying.
      variant={actor === "ours" ? "secondary" : "outline"}
    >
      {TURN_ACTORS[actor]}
    </Badge>
  );
}

function TurnStepRow({
  step,
  index,
}: {
  step: TurnStep | (typeof TURN_EXITS)[number];
  /** Shown for the numbered steps; omitted for the ways out, which are not ordered. */
  index?: number;
}) {
  const plane = step.plane
    ? HARNESS_PLANES.find((entry) => entry.id === step.plane)
    : undefined;

  return (
    <div className="flex gap-3">
      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-[0.65rem] text-muted-foreground">
        {index ?? "·"}
      </span>
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium text-sm">{step.label}</span>
          {"actor" in step ? <ActorBadge actor={step.actor} /> : null}
          {plane ? (
            <span className="text-muted-foreground text-xs">
              set on {plane.label}
            </span>
          ) : null}
        </div>
        <p className="text-muted-foreground text-xs">{step.detail}</p>
      </div>
    </div>
  );
}

/**
 * One turn, drawn as what it is: two things that happen once around something
 * that repeats.
 *
 * Not the dependency graph. That is a tree laid out by dagre, and a back edge in
 * it either gets reversed or wrecks the layout — but the deeper reason is that the
 * two drawings answer different questions. The graph says which parts exist and
 * where their settings live; this says what happens in what order and what runs
 * again on every pass. Forcing both into one picture is what left the Agent Loop
 * looking like a box beside Context rather than the thing that turns.
 *
 * Hand-built rather than a graph engine because the shape is fixed and small: four
 * steps and a return. Pan, zoom and layout would be machinery for nothing, and the
 * text is the content here.
 */
function TurnLoop() {
  return (
    <div className="space-y-4">
      <section className="space-y-3">
        <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Once, before the first pass
        </h4>
        {TURN_BEFORE.map((step, i) => (
          <TurnStepRow index={i + 1} key={step.id} step={step} />
        ))}
      </section>

      {/* The repeating part, enclosed and closed: the left rail plus the return
          row is what makes it read as a cycle rather than as four more items in a
          list. */}
      <section className="space-y-3 rounded-md border-l-2 border-l-primary bg-muted/30 p-3">
        <div className="flex items-center gap-1.5">
          <Repeat className="h-3.5 w-3.5 shrink-0 text-primary" />
          <h4 className="font-medium text-xs uppercase tracking-wide">
            Every pass, until something ends the turn
          </h4>
        </div>

        {TURN_LOOP.map((step, i) => (
          <TurnStepRow index={i + 1} key={step.id} step={step} />
        ))}

        <div className="flex items-center gap-2 border-t pt-2 text-muted-foreground text-xs">
          <CornerUpLeft className="h-3.5 w-3.5 shrink-0" />
          Back to step 1, with the result now part of the conversation.
        </div>
      </section>

      <section className="space-y-3">
        <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Ways out
        </h4>
        {TURN_EXITS.map((exit) => (
          <TurnStepRow key={exit.id} step={exit} />
        ))}
      </section>

      <section className="space-y-3">
        <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Once, after the last pass
        </h4>
        {TURN_AFTER.map((step, i) => (
          <TurnStepRow index={i + 1} key={step.id} step={step} />
        ))}
      </section>
    </div>
  );
}

/** The handlers one server's card needs, passed straight through. */
interface McpServerActions {
  busy: string | null;
  /** True in a project scope, where these belong to the user rather than here. */
  locked: boolean;
  onToggle: (server: McpServerRow) => void;
  onDelete: (server: McpServerRow) => void;
  onRefresh: (server: McpServerRow) => void;
  onToggleTool: (server: McpServerRow, tool: McpToolRow) => void;
}

/**
 * One connected server: what it is, whether it is on, and its tools one by one.
 *
 * Its own component because it is now rendered in two places — in the list under
 * MCP servers, and on its own when its box in the diagram is clicked. A connected
 * server is an outside dependency, so it earns a box the same way the provider
 * does, and clicking it has to lead somewhere real.
 *
 * Three separate decisions, deliberately not collapsed into one: add a server,
 * enable the server, and choose which of its tools it may offer. Enabling used to
 * be the only one, which made "capability" a weaker promise for MCP than for our
 * own operations — the session took whatever the server advertised, including
 * anything it added later.
 */
function McpServerCard({
  server,
  busy,
  locked,
  onToggle,
  onDelete,
  onRefresh,
  onToggleTool,
}: McpServerActions & { server: McpServerRow }) {
  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium text-sm">{server.name}</span>
          <Badge className="font-normal" variant="outline">
            {server.transport.toUpperCase()}
          </Badge>
          <Badge
            className="font-normal"
            variant={server.enabled ? "secondary" : "outline"}
          >
            {server.enabled ? "on" : "off"}
          </Badge>
        </div>
        <p className="break-all font-mono text-[0.7rem] text-muted-foreground">
          {server.url}
        </p>
        <p className="text-muted-foreground text-xs">
          {server.headerNames.length
            ? `Sends ${server.headerNames.join(", ")}`
            : "No auth header"}
          {server.tools
            ? ` · ${server.tools.filter((tool) => tool.enabled).length} of ${server.tools.length} tools on`
            : " · tools not read yet"}
        </p>
      </div>

      {/* Stacked, not a row: the panel is a column of about thirty characters and
          three buttons side by side wrapped into a ragged mess. */}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy === server.id || locked}
          onClick={() => onToggle(server)}
          size="sm"
          variant={server.enabled ? "secondary" : "default"}
        >
          {busy === server.id ? "…" : server.enabled ? "Disable" : "Enable"}
        </Button>
        <Button
          disabled={busy === server.id || locked}
          onClick={() => onRefresh(server)}
          size="sm"
          variant="outline"
        >
          Refresh tools
        </Button>
        <Button
          disabled={busy === server.id || locked}
          onClick={() => onDelete(server)}
          size="sm"
          variant="ghost"
        >
          Remove
        </Button>
      </div>

      {/* Null and empty are different answers. A server we could not reach keeps
          whatever list it had and says so; one that genuinely has no tools says
          that instead. Neither is an error. */}
      {server.tools === null ? (
        <p className="text-muted-foreground text-xs">
          We have not been able to read this server's tools, so the agent is
          offered all of them. Press Refresh tools to list them and switch them
          individually.
        </p>
      ) : server.tools.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          This server advertises no tools.
        </p>
      ) : (
        <div className="space-y-2">
          {server.tools.map((tool) => (
            <ToggleRow
              description={
                <>
                  {tool.description.slice(0, 160)}
                  {/* The server's word, labelled as such. It is the only signal
                      separating a lookup from a call that changes something on
                      somebody else's system. */}
                  {tool.readOnly ? null : (
                    <span className="mt-0.5 block text-amber-600 dark:text-amber-500">
                      Not declared read-only by the server.
                    </span>
                  )}
                </>
              }
              disabled={busy === `${server.id}:${tool.name}` || locked}
              hint={tool.readOnly ? "read-only" : undefined}
              key={tool.name}
              label={tool.title}
              on={tool.enabled}
              onToggle={() => onToggleTool(server, tool)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The form that connects a server, and nothing else.
 *
 * It used to list every connected server above the form. That list is the diagram
 * now: each server is a box of its own, and everything about it — enable, refresh,
 * its tools one by one — is in its own panel. Repeating the list here would put the
 * same switches in two places, which is the thing this screen keeps being rebuilt
 * to avoid.
 *
 * Still the only component here holding state, because a form is the only control
 * on this screen whose value does not already live in the loaded context.
 */
function McpServerForm({
  busy,
  locked,
  connectedCount,
  onAdd,
}: {
  busy: string | null;
  /** True in a project scope, where servers belong to the user rather than here. */
  locked: boolean;
  /** So the panel can say where the servers it is not listing have gone. */
  connectedCount: number;
  /** Resolves true when the server was stored, so the form can clear itself. */
  onAdd: (input: {
    name: string;
    url: string;
    transport: string;
    headerName: string;
    headerValue: string;
  }) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [transport, setTransport] = useState("http");
  const [headerName, setHeaderName] = useState("");
  const [headerValue, setHeaderValue] = useState("");

  const reset = () => {
    setName("");
    setUrl("");
    setTransport("http");
    setHeaderName("");
    setHeaderValue("");
    setOpen(false);
  };

  async function submit() {
    const stored = await onAdd({
      name,
      url,
      transport,
      headerName,
      headerValue,
    });
    if (stored) reset();
  }

  if (locked) {
    // A link rather than a sentence in a tooltip: in a project the form is hidden
    // because a server belongs to the person, and hiding it without saying where to
    // go left this panel with nothing to click.
    return (
      <p className="text-muted-foreground text-xs">
        Servers are the same for every project.{" "}
        <Link className="underline underline-offset-4" href="/agent">
          Connect one in Agent Settings
        </Link>
        .
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-xs">
        {connectedCount === 0
          ? "Nothing connected yet. The agent works entirely from your project, your module library and your linked application."
          : `${connectedCount} connected. Each one has its own box in the diagram — open it to enable the server or switch its tools.`}
      </p>

      {open ? (
        <div className="space-y-3 rounded-md border p-3">
          <div className="space-y-1.5">
            <Label htmlFor="mcp-name">Name</Label>
            <Input
              id="mcp-name"
              onChange={(event) => setName(event.target.value)}
              placeholder="enginsight"
              value={name}
            />
            {/* Said here rather than left to a validation error: the name is also
                the namespace its tools appear under, which is why it is
                restricted at all. */}
            <p className="text-muted-foreground text-xs">
              Letters, numbers, hyphens and underscores. The agent refers to the
              server by this name.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="mcp-transport">Transport</Label>
            <Select
              id="mcp-transport"
              onChange={(event) => setTransport(event.target.value)}
              value={transport}
            >
              <option value="http">HTTP (streamable)</option>
              <option value="sse">SSE</option>
            </Select>
            <p className="text-muted-foreground text-xs">
              HTTP unless the server's own documentation says otherwise.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="mcp-url">URL</Label>
            <Input
              id="mcp-url"
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://docs.example.com/~gitbook/mcp"
              value={url}
            />
            <p className="text-muted-foreground text-xs">
              Must be https on a public address. A server inside this server's
              own network is refused, because the agent would then be a way to
              reach things you cannot reach yourself.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="mcp-header-name">Auth header (optional)</Label>
            <Input
              id="mcp-header-name"
              onChange={(event) => setHeaderName(event.target.value)}
              placeholder="Authorization"
              value={headerName}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="mcp-header-value">Value</Label>
            <Input
              autoComplete="off"
              id="mcp-header-value"
              onChange={(event) => setHeaderValue(event.target.value)}
              placeholder="Bearer …"
              type="password"
              value={headerValue}
            />
            <p className="text-muted-foreground text-xs">
              Encrypted before it is stored and never sent back to this screen —
              you will see the header's name here, never what it holds. Leave
              both empty for a public server.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              disabled={busy === "mcp-add" || !name.trim() || !url.trim()}
              onClick={() => void submit()}
              size="sm"
            >
              {busy === "mcp-add" ? "Adding…" : "Add server"}
            </Button>
            <Button onClick={reset} size="sm" variant="ghost">
              Cancel
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            Added switched off, with its tools listed. It appears as its own box
            in the diagram, where you decide what to enable.
          </p>
        </div>
      ) : (
        <Button onClick={() => setOpen(true)} size="sm" variant="outline">
          Connect a server
        </Button>
      )}
    </div>
  );
}

/**
 * The agent's settings, one card per plane of the harness.
 *
 * The planes are in the order a turn passes through them — request configuration,
 * context, tools, guardrails, agent loop, memory, observability — because
 * the question a reader arrives with is "what will this agent do on my next turn",
 * and that is the order it happens in.
 *
 * Rendered both on the settings screen and in the modal the project chat opens, so
 * a change here reaches both and the two cannot disagree.
 */
export function AgentHarness({
  projectId,
  onChanged,
  withHeading = true,
}: {
  projectId?: string;
  /**
   * Fired after every saved change.
   *
   * The project chat shows the model and effort in its composer, and a settings
   * screen that changed them without telling it left two controls disagreeing
   * about what the next turn would run on.
   */
  onChanged?: () => void;
  /**
   * Whether to draw the card and the "Agent Harness" title around the diagram.
   *
   * False where the container already provides both, which is the project chat's
   * dialog. A prop rather than something derived from `projectId`: the two happen
   * to coincide today, but "am I looking at one project" and "does my container
   * already have a heading" are different questions, and only the caller can
   * answer the second.
   */
  withHeading?: boolean;
} = {}) {
  const [context, setContext] = useState<AgentContextView | null>(null);
  const toast = useToast();
  const [models, setModels] = useState<ModelOption[]>([]);
  /** Why this view is empty, when it is. Standing, so it stays on the page. */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [instructions, setInstructions] = useState("");
  const [instructionsSaved, setInstructionsSaved] = useState(false);
  /** The box whose settings the panel beside the diagram is showing. */
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const graph = useMemo(
    () => (context ? buildGraph(context) : null),
    [context],
  );

  const clearSelection = useCallback(() => setSelectedNode(null), []);

  // Clicking the same box again puts the panel away, so the box that opened it
  // is also the box that closes it.
  const handleNodeClick = useCallback((node: DependencyGraphNode) => {
    setSelectedNode((current) => (current === node.id ? null : node.id));
  }, []);

  // A box can disappear under the reader: switching off the module library takes
  // its node off the canvas, and a panel describing something no longer drawn
  // would be a dead end. The graph is rebuilt on every saved change, so this is
  // also what closes the panel when its own switch removes the node.
  useEffect(() => {
    if (!graph || !selectedNode) return;
    if (!graph.nodes.some((node) => node.id === selectedNode)) {
      setSelectedNode(null);
    }
  }, [graph, selectedNode]);

  const load = useCallback(async () => {
    const response = await fetch(
      projectId
        ? `/api/agent/context?projectId=${encodeURIComponent(projectId)}`
        : "/api/agent/context",
    );
    const body = await response.json();
    if (!response.ok) throw new Error(body?.error ?? "Failed to load");
    return body as AgentContextView;
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;

    load()
      .then((next) => {
        if (cancelled) return;
        setContext(next);
        setInstructions(next.instructions);
      })
      .catch(() => {
        if (!cancelled) setLoadError("Could not load the agent's context.");
      });

    return () => {
      cancelled = true;
    };
  }, [load]);

  // The catalogue depends on the user's Copilot entitlement, so it comes from the
  // runtime rather than from a list we maintain. A failure here leaves the model
  // dropdown with just the stored value, which is still enough to read.
  useEffect(() => {
    let cancelled = false;

    fetch("/api/agent/models")
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!cancelled && body) setModels(body.models ?? []);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Saves the instruction text.
   *
   * Its own request rather than `commit`, because PUT replaces the instructions
   * and a re-read has to put the saved text back into the textarea — otherwise a
   * trailing newline the server trimmed would reappear as an unsaved change.
   */
  async function saveInstructions() {
    setBusy("instructions");

    try {
      const response = await fetch("/api/agent/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instructions }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? "The instructions were not saved.");
      }

      const next = await load();
      setContext(next);
      setInstructions(next.instructions);
      setInstructionsSaved(true);
      onChanged?.();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "The instructions were not saved.",
      );
    } finally {
      setBusy(null);
    }
  }

  /** Re-reads the context after a change so the graph shows the saved truth. */
  async function commit(id: string, request: () => Promise<Response>) {
    setBusy(id);

    try {
      const response = await request();
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? "The change was not saved.");
      }
      setContext(await load());
      onChanged?.();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "The change was not saved.",
      );
    } finally {
      setBusy(null);
    }
  }

  /**
   * Writes one setting, to whichever scope this view is showing.
   *
   * In a project the whole override object has to be resent, because the endpoint
   * replaces it — sending only the changed key would drop every other override.
   * Globally each field is written on its own, so saving the model cannot rewrite
   * the timeout.
   */
  function save(id: string, patch: Record<string, unknown>) {
    if (projectId) {
      const merged: Record<string, unknown> = {
        ...(context?.overrides ?? {}),
        ...patch,
      };

      // "Follow the default" means "do not decide this here", so the key is
      // dropped rather than stored as null. Both inherit in the end, but a stored
      // null still counts as a key the project has an opinion about, and the
      // "this project" badge would go on claiming an override that resolves to
      // exactly the inherited value.
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete merged[key];
      }

      return commit(id, () =>
        fetch(`/api/projects/${projectId}/agent-settings`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(merged),
        }),
      );
    }

    return commit(id, () =>
      fetch("/api/agent/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }),
    );
  }

  /** Hands this project's settings back to the defaults, all of them at once. */
  function inheritEverything() {
    if (!projectId) return;

    return commit("inherit", () =>
      fetch(`/api/projects/${projectId}/agent-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
  }

  function toggleKnowledge(id: string, enabled: boolean) {
    if (!context) return;

    // Sent as the deny list the server stores, so "everything on" is an empty
    // array rather than a list that has to be kept in step with the catalogue.
    const disabledKnowledge = context.knowledge
      .filter((source) => (source.id === id ? enabled : !source.enabled))
      .map((source) => source.id);

    return save(id, { disabledKnowledge });
  }

  function toggleTool(name: string, enabled: boolean) {
    if (!context) return;

    const disabledTools = context.tools
      .filter((tool) => (tool.name === name ? enabled : !tool.enabled))
      .map((tool) => tool.name);

    return save(name, { disabledTools });
  }

  /**
   * Links or unlinks the application repository.
   *
   * Not routed through `save`: this is a column on the project rather than an
   * agent override, so it has its own endpoint and must not be folded into the
   * object that a PUT to `agent-settings` replaces wholesale.
   */
  function saveAppRepo(
    next: { fullName: string; branch: string | null } | null,
  ) {
    if (!projectId) return;

    return commit("app-repo-link", () =>
      fetch(`/api/projects/${projectId}/app-repo`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appRepo: next }),
      }),
    );
  }

  /**
   * Adds an MCP server, off until it is enabled.
   *
   * Not routed through `save` for the same reason the repository link is not:
   * these are rows of their own, not fields on the settings object a PUT
   * replaces. It reports whether the row was stored so the form knows whether to
   * clear itself — a rejected URL has to stay on screen to be corrected.
   */
  async function addMcpServer(input: {
    name: string;
    url: string;
    transport: string;
    headerName: string;
    headerValue: string;
  }): Promise<boolean> {
    setBusy("mcp-add");

    // One header rather than an editable list: the servers that authenticate at
    // all almost always want a single bearer token, and the API accepts up to ten
    // when a second one turns out to be needed.
    const header = input.headerName.trim();
    const headers = header ? { [header]: input.headerValue } : {};

    try {
      const response = await fetch("/api/agent/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: input.name.trim(),
          url: input.url.trim(),
          transport: input.transport,
          headers,
        }),
      });

      const body = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(body?.error ?? "The server was not added.");
      }

      // The row was stored even though its catalogue could not be read, so this
      // is a notice rather than an error: the fix is Refresh, not a re-add.
      if (body?.toolsProblem) {
        toast.info(
          `Server added, but its tools could not be read: ${body.toolsProblem}`,
        );
      }

      setContext(await load());
      onChanged?.();
      return true;
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "The server was not added.",
      );
      return false;
    } finally {
      setBusy(null);
    }
  }

  function toggleMcpServer(server: McpServerRow) {
    return commit(server.id, () =>
      fetch(`/api/agent/mcp/${encodeURIComponent(server.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !server.enabled }),
      }),
    );
  }

  function deleteMcpServer(server: McpServerRow) {
    return commit(server.id, () =>
      fetch(`/api/agent/mcp/${encodeURIComponent(server.id)}`, {
        method: "DELETE",
      }),
    );
  }

  /**
   * Re-reads one server's catalogue.
   *
   * Its own function rather than `commit` because the endpoint answers 200 with a
   * problem in the body: the request succeeded, the connection did not, and those
   * deserve different words on screen.
   */
  async function refreshMcpTools(server: McpServerRow) {
    setBusy(server.id);

    try {
      const response = await fetch(
        `/api/agent/mcp/${encodeURIComponent(server.id)}/tools`,
        { method: "POST" },
      );
      const body = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(body?.error ?? "The tools could not be read.");
      }

      if (body?.toolsProblem)
        toast.info(`${server.name}: ${body.toolsProblem}`);

      setContext(await load());
      onChanged?.();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "The tools could not be read.",
      );
    } finally {
      setBusy(null);
    }
  }

  function toggleMcpTool(server: McpServerRow, tool: McpToolRow) {
    // The deny list the server stores, rebuilt from what is on screen — the same
    // shape as every other tool switch here.
    const disabledTools = (server.tools ?? [])
      .filter((entry) =>
        entry.name === tool.name ? tool.enabled : !entry.enabled,
      )
      .map((entry) => entry.name);

    return commit(`${server.id}:${tool.name}`, () =>
      fetch(`/api/agent/mcp/${encodeURIComponent(server.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disabledTools }),
      }),
    );
  }

  const problem = loadError ? (
    <p className="flex items-center gap-2 text-destructive text-sm">
      <AlertCircle className="h-4 w-4 shrink-0" />
      {loadError}
    </p>
  ) : null;

  if (!context || !graph) {
    return (
      <div className="grid w-full grid-cols-1 gap-6">
        {problem}
        <Skeleton className="h-[28rem] w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  // What a turn would actually use, which is the stored choice or the default it
  // falls back to. Shown as the selection rather than offering an extra "Auto"
  // entry: the dropdown is then a list of model names and nothing else. A stored
  // choice that has left the user's Copilot list is not what runs, so the
  // default is selected instead and the note under the field names the old one.
  const model =
    context.model && !context.modelUnavailable
      ? context.model
      : context.defaults.model;
  const defaultModelName =
    models.find((entry) => entry.id === context.defaults.model)?.name ??
    context.defaults.model;
  const effort = context.reasoningEffort ?? context.defaults.reasoningEffort;

  // A list that does not contain the selected model would otherwise drop it and
  // read as though nothing were selected.
  const modelOptions = models.some((entry) => entry.id === model)
    ? models
    : [
        { id: model, name: model, reasoningEfforts: [], multiplier: null },
        ...models,
      ];

  const selectedModel = models.find((entry) => entry.id === model);
  // An empty list from the runtime means "unknown", not "supports nothing".
  const efforts: readonly string[] = selectedModel?.reasoningEfforts.length
    ? selectedModel.reasoningEfforts
    : REASONING_EFFORTS;
  /** Seconds are what the field stores; minutes are what the number means. */
  const minutes = (seconds: number) =>
    seconds % 60 === 0
      ? `${seconds / 60} minute${seconds === 60 ? "" : "s"}`
      : `${seconds} seconds`;

  const toolBudget = context.maxToolCalls ?? context.defaults.maxToolCalls;

  /** Characters are the honest unit and thousands are the readable one. */
  const thousands = (chars: number) =>
    `~${Math.round(chars / 1000)}k characters`;

  const isProject = context.scope === "project";
  const overrides = new Set(context.overridden);

  /**
   * Marks a card whose setting this project decides for itself.
   *
   * Takes a list because one card can hold more than one field — the application
   * reading caps are three numbers behind a single entry — and a badge watching
   * only the first would call the card inherited while two of its three inputs
   * showed an override.
   */
  const scopeBadge = (...fields: (string | undefined)[]) =>
    isProject && fields.some((field) => field && overrides.has(field)) ? (
      <Badge className="align-middle font-normal" variant="secondary">
        this project
      </Badge>
    ) : null;

  /**
   * The loaded context, past the guard above.
   *
   * Bound to a name so the renderers below can use it: TypeScript drops the
   * null-check when it crosses into a hoisted function declaration, since it
   * cannot prove the call happens after the guard rather than before it.
   */
  const view = context;

  const knowledgeFor = (element: HarnessElement) =>
    view.knowledge.find((source) => source.id === element.knowledgeId);

  /**
   * The control for one element, or null when the element is fixed.
   *
   * Switching on the element id rather than on its `setting`, because two elements
   * can share a setting: the three knowledge sources are all `disabledKnowledge`,
   * and each of them is still its own row with its own switch.
   */
  function controlFor(
    element: HarnessElement,
    /**
     * Namespaces the control's DOM ids.
     *
     * The same element can be on screen twice — once in the panel beside the
     * diagram, once in its card below — and duplicate ids would leave every
     * `<label for>` pointing at whichever copy the browser found first, so
     * clicking a label in the panel would focus a field further down the page.
     */
    scope: string,
  ): React.ReactNode {
    const fieldId = (name: string) => `${scope}-${name}`;

    switch (element.id) {
      case "model":
        return (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor={fieldId("agent-model")}>Model</Label>
              <Select
                disabled={busy === "model"}
                id={fieldId("agent-model")}
                onChange={(event) =>
                  void save("model", { model: event.target.value })
                }
                value={model}
              >
                {modelOptions.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                    {entry.preview ? " (preview)" : ""}
                    {entry.id === view.defaults.model ? " (default)" : ""}
                  </option>
                ))}
              </Select>
              {view.modelUnavailable && view.model ? (
                <p className="text-muted-foreground text-xs">
                  {view.model} is no longer available on your Copilot plan, so
                  turns use the default, {defaultModelName}. Pick a model to
                  change that.
                </p>
              ) : null}
              <p className="text-muted-foreground text-xs">
                {view.githubConnected
                  ? "Runs on your own Copilot seat, so usage is billed to you."
                  : "GitHub is not connected, so no turn can run."}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={fieldId("agent-effort")}>
                Thinking effort {scopeBadge("reasoningEffort")}
              </Label>
              <Select
                disabled={busy === "reasoningEffort"}
                id={fieldId("agent-effort")}
                onChange={(event) =>
                  void save("reasoningEffort", {
                    reasoningEffort: event.target.value,
                  })
                }
                value={effort}
              >
                {efforts.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </Select>
              <p className="text-muted-foreground text-xs">
                Only the levels this model accepts are offered.
              </p>
            </div>
          </div>
        );

      case "repo":
      case "library": {
        const source = knowledgeFor(element);
        if (!source) return null;

        return (
          <ToggleRow
            description={source.description}
            disabled={busy === source.id}
            label={source.enabled ? "In the prompt" : "Withheld"}
            on={source.enabled}
            onToggle={() => void toggleKnowledge(source.id, source.enabled)}
          />
        );
      }

      case "app-repo": {
        const source = knowledgeFor(element);

        return (
          <div className="space-y-2">
            {source ? (
              <ToggleRow
                description={source.description}
                disabled={busy === source.id}
                label={source.enabled ? "Readable" : "Withheld"}
                on={source.enabled}
                onToggle={() => void toggleKnowledge(source.id, source.enabled)}
              />
            ) : null}

            {/* Only in a project, because the link is a property of one. The
                switch above and this picker answer two questions that look the
                same from inside a turn — "may I read the application" and "is
                there an application to read" — so they belong together. */}
            {isProject ? (
              <>
                <AppRepoPicker
                  disabled={busy === "app-repo-link"}
                  onChange={(next) => void saveAppRepo(next)}
                  triggerId={fieldId("harness-app-repo")}
                  value={
                    view.appRepo
                      ? {
                          fullName: view.appRepo.fullName,
                          branch: view.appRepo.branch,
                        }
                      : null
                  }
                />
                {view.appRepo ? (
                  <p className="text-muted-foreground text-xs">
                    Read at{" "}
                    <code className="font-mono">
                      {view.appRepo.branch ?? "main"}
                    </code>
                    , read-only.
                  </p>
                ) : null}
              </>
            ) : (
              <p className="text-muted-foreground text-xs">
                A repository is linked per project, on that project's own
                harness.
              </p>
            )}
          </div>
        );
      }

      case "operations":
        return (
          <div className="space-y-3">
            {Object.entries(groupToolsByGroup(view.tools)).map(
              ([group, tools]) => (
                <div className="space-y-2" key={group}>
                  <h4 className="text-muted-foreground text-xs">
                    {TOOL_GROUP_LABELS[group] ?? group}
                  </h4>
                  <div className="space-y-2">
                    {tools.map((tool) => (
                      <ToggleRow
                        description={tool.summary}
                        disabled={busy === tool.name}
                        key={tool.name}
                        label={tool.label}
                        on={tool.enabled}
                        onToggle={() =>
                          void toggleTool(tool.name, tool.enabled)
                        }
                      />
                    ))}
                  </div>
                </div>
              ),
            )}
          </div>
        );

      case "mcp-servers":
        return (
          <McpServerForm
            busy={busy}
            connectedCount={view.mcpServers.length}
            locked={isProject}
            onAdd={addMcpServer}
          />
        );

      case "destructive":
        return (
          <ToggleRow
            description="Removing a module or a variable deletes the block and rewrites every reference to it. Off, those two operations are not registered at all. You can still remove anything yourself on the canvas."
            disabled={busy === "allowDestructive"}
            label={
              view.allowDestructive
                ? "The agent may delete"
                : "The agent may not delete"
            }
            on={view.allowDestructive}
            onToggle={() =>
              void save("allowDestructive", {
                allowDestructive: !view.allowDestructive,
              })
            }
          />
        );

      case "timeout":
        return (
          <NumberSetting
            busy={busy === "turnTimeout"}
            defaultValue={view.defaults.turnTimeout}
            describe={minutes}
            hint="It stops a stuck turn, not a working one. A turn killed while it was still making progress leaves no commit and no explanation."
            id={fieldId("agent-timeout")}
            label="How long a turn may run"
            max={TURN_TIMEOUT_MAX_SECONDS}
            min={TURN_TIMEOUT_MIN_SECONDS}
            onSave={(next) => void save("turnTimeout", { turnTimeout: next })}
            unit="seconds"
            value={view.turnTimeout}
          />
        );

      case "tool-budget":
        return (
          <NumberSetting
            busy={busy === "maxToolCalls"}
            defaultValue={view.defaults.maxToolCalls}
            hint="Each one becomes a commit after the turn, so this is the size of the largest change one unreviewed turn can make. Set to 1, the agent reports back after every single edit."
            id={fieldId("agent-tool-budget")}
            label="Operations per turn"
            max={TOOL_CALL_BUDGET_MAX}
            min={TOOL_CALL_BUDGET_MIN}
            onSave={(next) => void save("maxToolCalls", { maxToolCalls: next })}
            unit="operations"
            value={view.maxToolCalls}
          />
        );

      case "mcp-budget":
        return (
          <NumberSetting
            busy={busy === "maxMcpCalls"}
            defaultValue={view.defaults.maxMcpCalls}
            hint="Counted apart from operations, because a call changes nothing here — it is a request to a server you connected, on the credential you stored with it."
            id={fieldId("agent-mcp-budget")}
            label="MCP calls per turn"
            max={MCP_CALL_BUDGET_MAX}
            min={MCP_CALL_BUDGET_MIN}
            onSave={(next) => void save("maxMcpCalls", { maxMcpCalls: next })}
            unit="calls"
            value={view.maxMcpCalls}
          />
        );

      case "transcript":
        return (
          <NumberSetting
            busy={busy === "historyBudgetChars"}
            defaultValue={view.defaults.historyBudgetChars}
            describe={thousands}
            hint="The oldest messages are dropped first, so a decision argued out early in a long project is what falls off. It shares the model's context window with the project and the module library, so more is not free."
            id={fieldId("agent-history")}
            label="How much conversation is replayed"
            max={HISTORY_BUDGET_MAX_CHARS}
            min={HISTORY_BUDGET_MIN_CHARS}
            onSave={(next) =>
              void save("historyBudgetChars", { historyBudgetChars: next })
            }
            unit="characters"
            value={view.historyBudgetChars}
          />
        );

      case "steps":
        return (
          <NumberSetting
            busy={busy === "maxSteps"}
            defaultValue={view.defaults.maxSteps}
            hint={`Set it against your operation budget: a turn allowed ${toolBudget} operations needs room for ${toolBudget} entries plus the lookups and narration around them. About a quarter of the trail may be reasoning summaries, derived from this number so a narrating turn can never crowd out the record of what it committed.`}
            id={fieldId("agent-steps")}
            label="Entries recorded per turn"
            max={STEP_TRAIL_MAX}
            min={STEP_TRAIL_MIN}
            onSave={(next) => void save("maxSteps", { maxSteps: next })}
            unit="entries"
            value={view.maxSteps}
          />
        );

      case "app-repo-reads":
        return (
          <div className="space-y-4">
            <NumberSetting
              busy={busy === "maxAppRepoReads"}
              defaultValue={view.defaults.maxAppRepoReads}
              hint="Not on the operation budget: a read commits nothing, and sharing one budget would leave a turn that studied the application properly with nothing left to build with."
              id={fieldId("agent-app-reads")}
              label="Reads per turn"
              max={APP_REPO_READS_MAX}
              min={APP_REPO_READS_MIN}
              onSave={(next) =>
                void save("maxAppRepoReads", { maxAppRepoReads: next })
              }
              unit="reads"
              value={view.maxAppRepoReads}
            />
            <NumberSetting
              busy={busy === "appRepoTreeLimit"}
              defaultValue={view.defaults.appRepoTreeLimit}
              hint="Raise it for a large repository: narrowing the path is the intended remedy, and that needs a first listing broad enough to show which subtree to narrow to."
              id={fieldId("agent-app-tree")}
              label="Paths per listing"
              max={APP_REPO_TREE_MAX}
              min={APP_REPO_TREE_MIN}
              onSave={(next) =>
                void save("appRepoTreeLimit", { appRepoTreeLimit: next })
              }
              unit="paths"
              value={view.appRepoTreeLimit}
            />
            <NumberSetting
              busy={busy === "appRepoFileChars"}
              defaultValue={view.defaults.appRepoFileChars}
              describe={thousands}
              hint="Anything that states what an application needs — a manifest, a Dockerfile, a compose file — is far below this, so the truncation only hits files whose tail was not going to help."
              id={fieldId("agent-app-file")}
              label="Characters per file"
              max={APP_REPO_FILE_CHARS_MAX}
              min={APP_REPO_FILE_CHARS_MIN}
              onSave={(next) =>
                void save("appRepoFileChars", { appRepoFileChars: next })
              }
              unit="characters"
              value={view.appRepoFileChars}
            />
          </div>
        );

      case "instructions":
        return (
          <div className="space-y-2">
            <Textarea
              disabled={isProject}
              id={fieldId("agent-instructions")}
              onChange={(event) => {
                setInstructions(event.target.value);
                setInstructionsSaved(false);
              }}
              placeholder="e.g. Always name modules after the service they run, never after the AWS resource."
              rows={5}
              value={instructions}
            />
            {isProject ? (
              <p className="text-muted-foreground text-xs">
                The same for every project.{" "}
                <Link className="underline underline-offset-4" href="/agent">
                  Change them in Agent Settings
                </Link>
                .
              </p>
            ) : (
              <div className="flex items-center justify-between gap-2">
                <span
                  className={
                    instructions.length > MAX_INSTRUCTIONS
                      ? "text-destructive text-xs"
                      : "text-muted-foreground text-xs"
                  }
                >
                  {instructions.length} of {MAX_INSTRUCTIONS}
                </span>
                <div className="flex items-center gap-2">
                  {instructionsSaved ? (
                    <span className="text-muted-foreground text-xs">Saved</span>
                  ) : null}
                  <Button
                    disabled={
                      busy === "instructions" ||
                      instructions.length > MAX_INSTRUCTIONS ||
                      instructions === view.instructions
                    }
                    onClick={() => void saveInstructions()}
                    size="sm"
                    variant="secondary"
                  >
                    {busy === "instructions" ? "Saving…" : "Save"}
                  </Button>
                </div>
              </div>
            )}
          </div>
        );

      default:
        return null;
    }
  }

  /**
   * One card per plane, built from the plane's elements and nothing else.
   *
   * No `body` argument any more. It used to take hand-written JSX, which is how
   * the headings on this screen drifted away from the boxes in the diagram — the
   * card said "Limits" and the graph said "Operation budget", "Turn timeout".
   */
  /**
   * A plane's elements and their controls, with nothing around them.
   *
   * Extracted so the card below and the panel beside the diagram render the very
   * same thing. Two copies would be two things to keep in step, which is the
   * failure this whole screen was rebuilt to make impossible.
   */
  const planeBody = (id: HarnessPlane, scope: string) => (
    <div className="space-y-5">
      {/* The one plane that needs a picture as well as a list, and the only
          special case in here. Its elements are the limits that end a turn, which
          say nothing about the thing being limited — so the loop is drawn first and
          the limits read as what they are. Rendered from the same helper the card
          and the panel both use, so it appears in both. */}
      {id === "loop" ? (
        <div className="space-y-4">
          <TurnLoop />
          <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            What ends it
          </h4>
        </div>
      ) : null}

      {groupedElementsOnPlane(id).map(({ group, elements }) => (
        <div className="space-y-4" key={group ?? "ungrouped"}>
          {group ? (
            <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
              {group}
            </h3>
          ) : null}

          {elements.map((element) => (
            <ElementRow
              element={element}
              key={element.id}
              scopeBadge={scopeBadge(
                element.setting,
                ...(element.extraSettings ?? []),
              )}
            >
              {controlFor(element, `${scope}-${element.id}`)}
            </ElementRow>
          ))}
        </div>
      ))}

      {/* The planes underneath this one, named. Tools has no settings of its own —
          it is the three sources, and each of those is its own box — so without
          this its card would be a heading over nothing. Every plane with children
          gets the line, because "what is inside this" is worth answering wherever
          it is asked. */}
      <PlaneChildren of={id} />
    </div>
  );

  /**
   * What the panel shows for the box that was clicked.
   *
   * Every kind of node in the diagram resolves to something: an element to its
   * own control, a plane to all of its controls, the model to the setting that
   * chooses it, and the two outside systems to a description, because a provider
   * is not ours to configure.
   *
   * The control itself always comes from {@link controlFor}, so what appears here
   * is the same widget as in the card below rather than a second one that could
   * behave differently. Only the arrangement differs — a 24rem column has room
   * for the description in full, where the card puts it behind the info icon.
   */
  function panelFor(nodeId: string): {
    title: string;
    subtitle?: React.ReactNode;
    badges?: React.ReactNode;
    body: React.ReactNode;
  } | null {
    // The provider opens nothing. There is no setting behind it — it runs the
    // inference on the user's own seat — and a panel whose only content is a
    // paragraph would teach the reader that clicking sometimes does nothing
    // useful. What it is sits in the box and in the diagram's own explanation.
    if (HARNESS_EXTERNALS.some((entry) => entry.id === nodeId)) return null;

    // Data-driven boxes, so they are matched before the catalogue is consulted.
    if (nodeId.startsWith("mcp:")) {
      const server = view.mcpServers.find(
        (entry) => `mcp:${entry.id}` === nodeId,
      );
      if (!server) return null;

      return {
        title: server.name,
        subtitle: "Connected MCP server",
        badges: (
          <Badge className="font-normal" variant="outline">
            {THIRD_PARTY}
          </Badge>
        ),
        body: (
          <McpServerCard
            busy={busy}
            locked={isProject}
            onDelete={(entry) => void deleteMcpServer(entry)}
            onRefresh={(entry) => void refreshMcpTools(entry)}
            onToggle={(entry) => void toggleMcpServer(entry)}
            onToggleTool={(entry, tool) => void toggleMcpTool(entry, tool)}
            server={server}
          />
        ),
      };
    }

    // Tools opens nothing. It has no settings of its own — it is the three
    // sources, and each of those is a box with its own panel — so a panel here
    // would be a heading over a pointer to three other panels.
    if (nodeId === "plane:tools") return null;

    if (nodeId.startsWith("plane:")) {
      const meta = HARNESS_PLANES.find(
        (entry) => `plane:${entry.id}` === nodeId,
      );
      if (!meta) return null;

      return {
        title: meta.label,
        subtitle: meta.summary,
        badges: (
          <Badge className="font-normal" variant="outline">
            {anchorLabel(meta.attachesTo)}
          </Badge>
        ),
        body: planeBody(meta.id, "panel"),
      };
    }

    // Only planes and the two outside systems are drawn, so there is nothing
    // else a click can arrive from. An element is reached through its plane,
    // which is also what stops the panel from becoming a second place where a
    // single control is arranged differently.
    return null;
  }

  const panel = selectedNode ? panelFor(selectedNode) : null;

  /**
   * The drawing and the panel beside it, which is the whole screen now.
   *
   * Held in a variable rather than repeated in both branches below: the only
   * difference between the settings page and the dialog is whether a card and a
   * heading go around this, and writing it twice would be two things to keep in
   * step for one border.
   *
   * The panel is a column beside the canvas rather than an overlay, matching the
   * module diagrams: reading a harness means clicking one box after another, and a
   * sheet would cover the drawing you are working from. The canvas shrinks
   * instead, which is what `KeepSelectionInView` inside the graph is built for —
   * it pans the picked box back into view rather than leaving it behind the panel.
   */
  const canvas = (
    <div className="flex flex-col gap-4 lg:flex-row">
      {/* Top to bottom rather than left to right: the harness is a
            hierarchy between two outside systems, and the drawing reads in
            the direction the page scrolls. */}
      <DependencyGraph
        className="h-[calc(100vh-22rem)] min-h-[32rem] min-w-0 flex-1"
        // Every description here is written to fit, so the clamp is a
        // guarantee rather than a fallback.
        descriptionLines={2}
        direction="TB"
        edges={graph.edges}
        highlightedNodeId={selectedNode}
        nodes={graph.nodes}
        onNodeClick={handleNodeClick}
        onPaneClick={clearSelection}
        showMiniMap={false}
      />

      {/* Nothing when nothing is picked, so the canvas's `flex-1` takes the
            whole width back. No placeholder holding the column open: the
            drawing is the thing worth the space, and a hint that never
            changes is read once and then in the way forever. */}
      {panel ? (
        <GraphDetailPanel
          badges={panel.badges}
          className="h-[calc(100vh-22rem)] min-h-[32rem] lg:w-[26rem] xl:w-[32rem]"
          mono={false}
          onClose={clearSelection}
          subtitle={panel.subtitle}
          title={panel.title}
        >
          {panel.body}
        </GraphDetailPanel>
      ) : null}
    </div>
  );

  return (
    <div className="grid w-full grid-cols-1 gap-6">
      {problem}

      {isProject ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
          <span>
            These settings apply to <strong>this project only</strong>. Anything
            you do not change here follows your defaults from Agent Settings.
          </span>
          <Button
            disabled={busy === "inherit" || overrides.size === 0}
            onClick={() => void inheritEverything()}
            size="sm"
            variant="outline"
          >
            {busy === "inherit" ? "Resetting…" : "Follow defaults again"}
          </Button>
        </div>
      ) : null}

      {/* Wrapped in a card on the settings page, bare inside the project chat's
          dialog — which already carries the heading, and a card titled "Agent
          Harness" under a dialog titled "Agent Harness" is the same words twice
          with a border between them. The caller decides, because whether a
          heading already exists is the container's knowledge and not something
          this component can work out. */}
      {withHeading ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5">
              Agent Harness
              <InfoHint label="Agent Harness">
                The spine runs provider, model, agent loop. The first two are
                outside the harness and drawn in the paler colour: the provider
                runs the turn on your own Copilot seat, and the model runs there
                too, so neither is ours — only the choice of which model is. Any
                MCP server you connect is outside in the same way. Everything
                else hangs off the loop, which is what consumes it: each pass
                assembles context, offers the tools, checks a call and writes
                the trail. Every box holds its own settings — click one and they
                open beside the drawing, with a badge saying how strongly each
                part holds: impossible to go around, checked when tried, or
                merely asked. Open the Agent Loop for what one turn actually
                does, step by step, and where the commit to your repository
                fits.
              </InfoHint>
            </CardTitle>
          </CardHeader>
          <CardContent>{canvas}</CardContent>
        </Card>
      ) : (
        canvas
      )}
    </div>
  );
}
