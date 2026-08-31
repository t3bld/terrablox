"use client";

import type {
  DependencyGraphEdge,
  DependencyGraphNode,
} from "@terrablox/graph/dependency-graph";
import { DependencyGraph } from "@terrablox/graph/dependency-graph";
import { Badge } from "@terrablox/ui/badge";
import { Button } from "@terrablox/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@terrablox/ui/card";
import { Input } from "@terrablox/ui/input";
import { Label } from "@terrablox/ui/label";
import { Select } from "@terrablox/ui/select";
import { Skeleton } from "@terrablox/ui/skeleton";
import { Textarea } from "@terrablox/ui/textarea";
import { ToggleRow } from "@terrablox/ui/toggle-row";
import { AlertCircle } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { InfoHint } from "@/components/info-hint";
import { AppRepoPicker } from "@/components/projects/app-repo-picker";
import {
  elementsOnPlane,
  HARNESS_ENFORCEMENT,
  HARNESS_PLANES,
  type HarnessElement,
  type HarnessEnforcement,
  type HarnessPlane,
} from "@/lib/agent/harness-model";
import {
  AGENT_MAX_MCP_CALLS,
  AGENT_MAX_STEPS,
  AGENT_MAX_TOOL_CALLS,
  REASONING_EFFORTS,
  TURN_TIMEOUT_CHOICES,
} from "@/lib/agent/runtime-options";

/** Mirrors MAX_INSTRUCTIONS_LENGTH in the settings service. */
const MAX_INSTRUCTIONS = 4000;

const TOOL_GROUP_LABELS: Record<string, string> = {
  library: "Module library",
  review: "Planning and review",
  modules: "Modules",
  locals: "Variables",
  "app-repo": "Application repository",
};

type ToolView = {
  name: string;
  group: string;
  label: string;
  summary: string;
  enabled: boolean;
};

function groupToolsByGroup(tools: ToolView[]): Record<string, ToolView[]> {
  const groups: Record<string, ToolView[]> = {};
  for (const tool of tools) {
    const key = tool.group;
    if (!groups[key]) groups[key] = [];
    groups[key].push(tool);
  }
  return groups;
}

/**
 * One connected MCP server, as the settings service reports it.
 *
 * `headerNames` and no header values: they are the credential the requests are
 * made with, encrypted at rest, and the server never sends them back. The names
 * are enough to answer the only question the screen has to answer — whether this
 * connection authenticates itself, and with which header.
 */
type McpServerRow = {
  id: string;
  name: string;
  url: string;
  transport: "http" | "sse";
  enabled: boolean;
  headerNames: string[];
};

interface AgentContextView {
  /** Whose settings these are: everyone's defaults, or one project's. */
  scope: "global" | "project";
  /** Fields this project decides itself. Empty in the global scope. */
  overridden: string[];
  /** The project's stored overrides, resent on save because a PUT replaces them. */
  overrides: Record<string, unknown>;
  /** The stored choice. Null means the default decides. */
  model: string | null;
  reasoningEffort: string | null;
  /** Seconds a turn may run. Null means the default. */
  turnTimeout: number | null;
  /** Whether the agent may delete modules and variables. */
  allowDestructive: boolean;
  /** What a null choice above resolves to, so the UI can name it. */
  defaults: {
    model: string;
    reasoningEffort: string;
    turnTimeout: number;
  };
  githubConnected: boolean;
  instructions: string;
  instructionsLength: number;
  knowledge: Array<{
    id: string;
    name: string;
    description: string;
    enabled: boolean;
  }>;
  /**
   * The application repository this project reads, if it has one.
   *
   * Always null in the global scope: a link belongs to one project, so the
   * defaults view has nothing to show and nothing to change.
   */
  appRepo: { fullName: string; branch: string | null } | null;
  moduleCount: number;
  projectCount: number;
  tools: ToolView[];
  /**
   * The user's connected MCP servers. Identical in both scopes.
   *
   * A server is a URL plus a credential belonging to the person who added it, so
   * it is not a per-project choice: a project that could switch one on would be
   * enabling a connection its owner may never have looked at.
   */
  mcpServers: McpServerRow[];
}

interface ModelOption {
  id: string;
  name: string;
  reasoningEfforts: string[];
  multiplier: number | null;
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

/** The parts of a plane nobody can change, stated rather than offered. */
function FixedElements({ elements }: { elements: HarnessElement[] }) {
  if (elements.length === 0) return null;

  return (
    <dl className="grid gap-2 text-xs md:grid-cols-2">
      {elements.map((element) => (
        <div className="rounded-md border border-dashed p-2.5" key={element.id}>
          <dt className="flex items-start justify-between gap-2 font-medium">
            <span>{element.label}</span>
            <EnforcementBadge kind={element.enforcement} />
          </dt>
          <dd className="mt-1 text-muted-foreground">{element.description}</dd>
          {/* Named so the claim above can be checked in the code rather than
              taken on trust from the screen that makes it. */}
          <dd className="mt-1 font-mono text-[0.65rem] text-muted-foreground/70">
            {element.source}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The connected MCP servers, and the form that adds one.
 *
 * Its own component because it is the only part of this screen with a form to
 * hold: everything else on the harness is a toggle or a dropdown whose value
 * already lives in the loaded context, and keeping four half-typed fields in the
 * parent would re-render the whole harness on every keystroke.
 *
 * Adding and enabling are two steps, matching the API: a stored server is off
 * until somebody makes the second decision deliberately. So the form's button
 * says "Add" rather than "Connect", and the switch beside a row is what actually
 * hands the agent that server's tools.
 */
function McpServers({
  servers,
  busy,
  /** True in a project scope, where these belong to the user rather than here. */
  locked,
  onToggle,
  onDelete,
  onAdd,
}: {
  servers: McpServerRow[];
  busy: string | null;
  locked: boolean;
  onToggle: (server: McpServerRow) => void;
  onDelete: (server: McpServerRow) => void;
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

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          MCP servers
        </h3>
        <EnforcementBadge kind="capability" />
        <InfoHint label="MCP servers">
          Outside tool providers you connect yourself. A server that is off is
          not on the session at all, so the agent cannot reach it. Switching one
          on is a decision about the whole server: it grants every tool that
          server advertises, now and later, and the turn runs unattended so
          those calls are not confirmed one by one.
          {locked
            ? " Servers are the same for every project — add or change them in Agent Settings."
            : null}
        </InfoHint>
      </div>

      {servers.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          Nothing connected. The agent works entirely from your project, your
          module library and your linked application.
        </p>
      ) : null}

      {/* A link rather than a sentence. In a project the form is hidden because a
          server belongs to the person, not the project — but saying so in a
          tooltip left this section with nothing to click and no way to find the
          screen that does have the form. */}
      {locked ? (
        <p className="text-muted-foreground text-xs">
          Servers are the same for every project.{" "}
          <Link className="underline underline-offset-4" href="/agent">
            Connect one in Agent Settings
          </Link>
          .
        </p>
      ) : null}

      {servers.length === 0 ? null : (
        <div className="space-y-2">
          {servers.map((server) => (
            <div className="flex items-start gap-2" key={server.id}>
              {/* The row is the switch, and the delete button sits outside it: a
                  button inside a button is neither valid nor clickable. */}
              <ToggleRow
                className="flex-1"
                description={
                  <>
                    <span className="break-all font-mono">{server.url}</span>
                    {server.headerNames.length ? (
                      <span>
                        {" · sends "}
                        {server.headerNames.join(", ")}
                      </span>
                    ) : (
                      <span> · no auth header</span>
                    )}
                  </>
                }
                disabled={busy === server.id || locked}
                hint={server.transport.toUpperCase()}
                label={server.name}
                on={server.enabled}
                onToggle={() => onToggle(server)}
              />
              <Button
                disabled={busy === server.id || locked}
                onClick={() => onDelete(server)}
                size="sm"
                variant="outline"
              >
                Remove
              </Button>
            </div>
          ))}
        </div>
      )}

      {locked ? null : open ? (
        <div className="space-y-3 rounded-md border p-3">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="mcp-name">Name</Label>
              <Input
                id="mcp-name"
                onChange={(event) => setName(event.target.value)}
                placeholder="enginsight"
                value={name}
              />
              {/* Said here rather than left to a validation error: the name is
                  also the namespace its tools appear under, which is why it is
                  restricted at all. */}
              <p className="text-muted-foreground text-xs">
                Letters, numbers, hyphens and underscores. The agent refers to
                the server by this name.
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

          <div className="grid gap-3 md:grid-cols-2">
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
            </div>
          </div>

          <p className="text-muted-foreground text-xs">
            The value is encrypted before it is stored and is never sent back to
            this screen — you will see the header's name here, never what it
            holds. Leave both empty for a public server.
          </p>

          <div className="flex items-center gap-2">
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
            <span className="text-muted-foreground text-xs">
              Added switched off. You enable it above.
            </span>
          </div>
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
 * The agent's settings, grouped by how each one reaches the model.
 *
 * One card per plane of the harness — request configuration, context, action
 * space, mediation, control loop, state, observability — in the order a turn
 * passes through them. The earlier version grouped by topic instead (Model,
 * Context, Operations, Guardrails), which put a permission that is enforced by
 * absence next to a sentence the model may ignore and gave the reader no way to
 * tell them apart.
 *
 * Rendered both on the settings screen and in the modal the project chat opens,
 * so a change here reaches both and the two cannot disagree.
 */
export function AgentHarness({
  projectId,
  onChanged,
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
} = {}) {
  const [context, setContext] = useState<AgentContextView | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [instructions, setInstructions] = useState("");
  const [instructionsSaved, setInstructionsSaved] = useState(false);
  const graph = useMemo(
    () => (context ? buildGraph(context) : null),
    [context],
  );

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
        if (!cancelled) setError("Could not load the agent's context.");
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
    setError(null);

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
      setError(
        err instanceof Error ? err.message : "The instructions were not saved.",
      );
    } finally {
      setBusy(null);
    }
  }

  /** Re-reads the context after a change so the graph shows the saved truth. */
  async function commit(id: string, request: () => Promise<Response>) {
    setBusy(id);
    setError(null);

    try {
      const response = await request();
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? "The change was not saved.");
      }
      setContext(await load());
      onChanged?.();
    } catch (err) {
      setError(
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
      return commit(id, () =>
        fetch(`/api/projects/${projectId}/agent-settings`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...(context?.overrides ?? {}), ...patch }),
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
    setError(null);

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

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? "The server was not added.");
      }

      setContext(await load());
      onChanged?.();
      return true;
    } catch (err) {
      setError(
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

  const problem = error ? (
    <p className="flex items-center gap-2 text-sm text-destructive">
      <AlertCircle className="h-4 w-4 shrink-0" />
      {error}
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
  // entry: the dropdown is then a list of model names and nothing else.
  const model = context.model ?? context.defaults.model;
  const effort = context.reasoningEffort ?? context.defaults.reasoningEffort;
  const timeout = context.turnTimeout ?? context.defaults.turnTimeout;

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
  // A stored value that is not one of the presets still has to be selectable, or
  // the dropdown would silently show a different number than the agent uses.
  const timeoutChoices = TURN_TIMEOUT_CHOICES.some(
    (choice) => choice.seconds === timeout,
  )
    ? TURN_TIMEOUT_CHOICES
    : [
        ...TURN_TIMEOUT_CHOICES,
        { seconds: timeout, label: `${timeout}s` },
      ].sort((a, b) => a.seconds - b.seconds);

  const isProject = context.scope === "project";
  /** Marks a card whose setting this project decides for itself. */
  const overrides = new Set(context.overridden);

  const scopeBadge = (field: string) =>
    isProject && overrides.has(field) ? (
      <Badge className="align-middle font-normal" variant="secondary">
        this project
      </Badge>
    ) : null;

  /** Card shell for one plane, so the seven of them cannot drift apart. */
  const plane = (id: HarnessPlane, body: React.ReactNode) => {
    const meta = HARNESS_PLANES.find((entry) => entry.id === id);
    if (!meta) return null;

    // Only the ones without a control of their own: an element that has a
    // setting is represented by that setting, not by a paragraph beside it.
    const fixed = elementsOnPlane(id).filter((element) => !element.setting);

    return (
      <Card key={id}>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-1.5">
            {meta.label}
            <InfoHint label={meta.label}>
              {meta.summary} {meta.integration}
            </InfoHint>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {body}
          <FixedElements elements={fixed} />
        </CardContent>
      </Card>
    );
  };

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

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5">
            Agent Harness
            <InfoHint label="Agent Harness">
              The model in the middle and the seven planes around it. Each plane
              is a different way of reaching the model, and the badge on every
              part says which — whether it is impossible for the agent to go
              around, checked when it tries, or merely asked of it.
            </InfoHint>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {/* Top to bottom rather than left to right: the harness is a hierarchy,
              not a pipeline, and the drawing reads in the direction the page
              scrolls. */}
          <DependencyGraph
            className="h-[38rem] w-full"
            // Every description here is written to fit, so the clamp is a
            // guarantee rather than a fallback.
            descriptionLines={2}
            direction="TB"
            edges={graph.edges}
            nodes={graph.nodes}
            showMiniMap={false}
          />
        </CardContent>
      </Card>

      {plane(
        "config",
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              What the turn runs on
            </h3>
            <EnforcementBadge kind="provider-config" />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="agent-model">Model {scopeBadge("model")}</Label>
              <Select
                disabled={busy === "model"}
                id="agent-model"
                onChange={(event) =>
                  void save("model", { model: event.target.value })
                }
                value={model}
              >
                {modelOptions.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-muted-foreground">
                {context.githubConnected
                  ? "Runs on your own Copilot seat, so usage is billed to you."
                  : "GitHub is not connected, so no turn can run."}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="agent-effort">
                Thinking Effort {scopeBadge("reasoningEffort")}
              </Label>
              <Select
                disabled={busy === "reasoningEffort"}
                id="agent-effort"
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
              <p className="text-xs text-muted-foreground">
                Only the levels this model accepts are offered.
              </p>
            </div>
          </div>
        </div>,
      )}

      {plane(
        "context",
        <div className="space-y-4">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Knowledge sources
              </h3>
              {scopeBadge("disabledKnowledge")}
              <InfoHint label="Knowledge sources">
                The content is prompt text and therefore advisory — but
                switching a source off does not ask the agent to ignore it. The
                prompt is built without it, and absence is not advisory.
              </InfoHint>
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              {context.knowledge.map((source) => (
                <ToggleRow
                  description={source.description}
                  disabled={busy === source.id}
                  key={source.id}
                  label={source.name}
                  on={source.enabled}
                  onToggle={() =>
                    void toggleKnowledge(source.id, source.enabled)
                  }
                />
              ))}
            </div>
          </div>

          {/* Only in a project, because the link is a property of one. The switch
              above and this picker answer two different questions that look the
              same from inside a turn — "may I read the application" and "is there
              an application to read" — so they belong next to each other. */}
          {isProject ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <Label htmlFor="harness-app-repo">Application repository</Label>
                <EnforcementBadge kind="capability" />
                <InfoHint label="Application repository">
                  The repository holding the application this infrastructure is
                  for. The agent may read its files to see how the application
                  is built, and has no tool that writes to it. Without a link
                  those read tools are not registered at all, and the agent is
                  told to ask about the application instead.
                </InfoHint>
              </div>
              <AppRepoPicker
                disabled={busy === "app-repo-link"}
                onChange={(next) => void saveAppRepo(next)}
                triggerId="harness-app-repo"
                value={
                  context.appRepo
                    ? {
                        fullName: context.appRepo.fullName,
                        branch: context.appRepo.branch,
                      }
                    : null
                }
              />
              {context.appRepo ? (
                <p className="text-xs text-muted-foreground">
                  Read at{" "}
                  <code className="font-mono">
                    {context.appRepo.branch ?? "main"}
                  </code>
                  , read-only.
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <Label htmlFor="agent-instructions">Your instructions</Label>
              <EnforcementBadge kind="prompt" />
              <InfoHint label="Your instructions">
                {isProject
                  ? "Standing preferences, added to every turn. They are the same for every project — change them in Agent Settings."
                  : "Standing preferences, added to every turn across all of your projects."}
              </InfoHint>
            </div>
            <Textarea
              disabled={isProject}
              id="agent-instructions"
              onChange={(event) => {
                setInstructions(event.target.value);
                setInstructionsSaved(false);
              }}
              placeholder="e.g. Always name modules after the service they run, never after the AWS resource."
              rows={5}
              value={instructions}
            />
            <div
              className={`flex items-center justify-between gap-2 ${
                isProject ? "hidden" : ""
              }`}
            >
              <span
                className={`text-xs ${
                  instructions.length > MAX_INSTRUCTIONS
                    ? "text-destructive"
                    : "text-muted-foreground"
                }`}
              >
                {instructions.length} of {MAX_INSTRUCTIONS}
              </span>
              <div className="flex items-center gap-2">
                {instructionsSaved ? (
                  <span className="text-xs text-muted-foreground">Saved</span>
                ) : null}
                <Button
                  disabled={
                    busy === "instructions" ||
                    instructions.length > MAX_INSTRUCTIONS ||
                    instructions === context.instructions
                  }
                  onClick={() => void saveInstructions()}
                  size="sm"
                  variant="secondary"
                >
                  {busy === "instructions" ? "Saving…" : "Save"}
                </Button>
              </div>
            </div>
          </div>
        </div>,
      )}

      {plane(
        "actions",
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Operations
            </h3>
            {scopeBadge("disabledTools")}
            <EnforcementBadge kind="capability" />
            <InfoHint label="Operations">
              An operation switched off is not registered on the session, so the
              agent cannot call it. The prompt names what is unavailable, so it
              says what it cannot do instead of trying and failing.
            </InfoHint>
          </div>

          {Object.entries(groupToolsByGroup(context.tools)).map(
            ([group, tools]) => (
              <div className="space-y-2" key={group}>
                <h4 className="text-xs font-medium text-muted-foreground">
                  {TOOL_GROUP_LABELS[group] ?? group}
                </h4>
                <div className="grid gap-2 md:grid-cols-3">
                  {tools.map((tool) => (
                    <ToggleRow
                      description={tool.summary}
                      disabled={busy === tool.name}
                      key={tool.name}
                      label={tool.label}
                      on={tool.enabled}
                      onToggle={() => void toggleTool(tool.name, tool.enabled)}
                    />
                  ))}
                </div>
              </div>
            ),
          )}

          {/* On this plane rather than a card of its own: an MCP tool and one of
              our operations reach the model the same way, and the only difference
              worth showing is who wrote it. Splitting them would suggest the
              outside ones are governed by something else. */}
          <McpServers
            busy={busy}
            locked={isProject}
            onAdd={addMcpServer}
            onDelete={(server) => void deleteMcpServer(server)}
            onToggle={(server) => void toggleMcpServer(server)}
            servers={context.mcpServers}
          />
        </div>,
      )}

      {plane(
        "mediation",
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Permission
            </h3>
            {scopeBadge("allowDestructive")}
            <EnforcementBadge kind="capability" />
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            <ToggleRow
              description="Removing a module or a variable deletes the block and rewrites every reference to it. Off, those two operations are not registered at all, so this is a capability the agent lacks rather than a rule it is asked to respect. You can still remove anything yourself on the canvas."
              disabled={busy === "allowDestructive"}
              label="Let the agent delete"
              on={context.allowDestructive}
              onToggle={() =>
                void save("allowDestructive", {
                  allowDestructive: !context.allowDestructive,
                })
              }
            />
          </div>
        </div>,
      )}

      {plane(
        "control",
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Limits
            </h3>
            <EnforcementBadge kind="control-loop" />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="agent-timeout">
                Turn Timeout {scopeBadge("turnTimeout")}
              </Label>
              <Select
                disabled={busy === "turnTimeout"}
                id="agent-timeout"
                onChange={(event) =>
                  void save("turnTimeout", {
                    turnTimeout: Number(event.target.value),
                  })
                }
                value={String(timeout)}
              >
                {timeoutChoices.map((choice) => (
                  <option key={choice.seconds} value={choice.seconds}>
                    {choice.label}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-muted-foreground">
                On expiry the request is aborted and the session deleted, and
                nothing is committed.
              </p>
            </div>
          </div>
        </div>,
      )}

      {plane("state", null)}
      {plane("observability", null)}
    </div>
  );
}

/**
 * The harness as the model plus the seven planes around it.
 *
 * The planes come from `harness-model.ts`, which is also what the cards above are
 * built from — so a part cannot appear in the diagram and be missing from the
 * list, which is what happened while the two carried their own copies of the same
 * sentences.
 *
 * The model is the centre because it is the thing being harnessed. Everything
 * else is a way of reaching it, and the node kind says how strong that way is:
 * enforced parts are drawn as solid boxes, advisory and recorded ones as dashed
 * read-only ones.
 *
 * Parts that are switched off are left out rather than greyed. The question this
 * diagram answers is what *this* agent can do on the next turn, not what the
 * feature could do for somebody else.
 */
function buildGraph(context: AgentContextView): {
  nodes: DependencyGraphNode[];
  edges: DependencyGraphEdge[];
} {
  const enabledTools = context.tools.filter((tool) => tool.enabled);
  const enabledServers = context.mcpServers.filter((server) => server.enabled);
  const knowledgeOn = (id: string) =>
    context.knowledge.some((source) => source.id === id && source.enabled);

  /** Roomier than the default so a description is not clipped. */
  const box = { width: 320, height: 152 } as const;

  const nodes: DependencyGraphNode[] = [
    // Above the model, because it is what the model runs on: the layout is
    // top-down, so an edge into `model` puts this node over it. It is not one of
    // the planes — the planes are ours, the provider is not.
    {
      id: "provider",
      label: "GitHub Copilot",
      kind: "external-module",
      group: "Provider",
      description: context.githubConnected
        ? "Runs the turn on your own Copilot seat."
        : "Not connected, so no turn can run.",
      metadata: {
        status: context.githubConnected ? "connected" : "not connected",
      },
      ...box,
    },
    {
      id: "model",
      label: "Model",
      kind: "module",
      group: "Harness",
      description: "Reads what it is given, calls operations, then answers.",
      metadata: {
        model: context.model ?? `default (${context.defaults.model})`,
        effort:
          context.reasoningEffort ??
          `default (${context.defaults.reasoningEffort})`,
      },
      ...box,
    },
  ];

  const edges: DependencyGraphEdge[] = [
    { source: "provider", target: "model" },
  ];

  /** Live numbers for the elements whose value depends on these settings. */
  const liveMetadata: Record<string, Record<string, string | number>> = {
    operations: {
      allowed: `${enabledTools.length} of ${context.tools.length}`,
    },
    library: { modules: context.moduleCount },
    instructions: { characters: context.instructionsLength },
    destructive: {
      state: context.allowDestructive ? "allowed" : "not allowed",
    },
    "mcp-servers": {
      // The enabled count, not the stored one: a server that is off is not on
      // the session, so counting it here would draw a capability nobody has.
      enabled: `${enabledServers.length} of ${context.mcpServers.length}`,
      ...(enabledServers.length
        ? { servers: enabledServers.map((server) => server.name).join(", ") }
        : {}),
    },
    "tool-budget": { limit: `max ${AGENT_MAX_TOOL_CALLS}` },
    "mcp-budget": { limit: `max ${AGENT_MAX_MCP_CALLS}` },
    timeout: {
      limit: `${context.turnTimeout ?? context.defaults.turnTimeout}s`,
    },
    steps: { cap: `max ${AGENT_MAX_STEPS}` },
    git: { projects: context.projectCount },
  };

  /** Elements the current settings leave out of the turn entirely. */
  const omitted = (element: HarnessElement) => {
    if (element.id === "repo") return !knowledgeOn("project-repo");
    if (element.id === "library") return !knowledgeOn("module-library");
    if (element.id === "instructions") return context.instructionsLength === 0;
    // With nothing enabled the MCP namespace is not on the session and there is
    // no budget to spend, so drawing either would overstate what a turn can do.
    if (element.id === "mcp-servers" || element.id === "mcp-budget") {
      return enabledServers.length === 0;
    }
    // Both are drawn as nodes of their own above the planes: the model is the
    // centre, and the identity is the provider box over it.
    return element.id === "model" || element.id === "identity";
  };

  for (const meta of HARNESS_PLANES) {
    nodes.push({
      id: `plane:${meta.id}`,
      label: meta.label,
      kind: "module",
      group: "Plane",
      description: meta.summary,
      ...box,
    });
    edges.push({ source: "model", target: `plane:${meta.id}` });

    for (const element of elementsOnPlane(meta.id)) {
      if (omitted(element)) continue;

      const strength = HARNESS_ENFORCEMENT[element.enforcement].strength;

      nodes.push({
        id: element.id,
        label: element.label,
        // Solid for something the agent cannot go around, dashed and badged
        // read-only for something that only describes or records.
        kind: strength === "enforced" ? "resource" : "data",
        group: HARNESS_ENFORCEMENT[element.enforcement].label,
        // The short text: a node is three lines tall, and the card below already
        // carries the precise version.
        description: element.brief,
        metadata: liveMetadata[element.id],
      });
      edges.push({ source: `plane:${meta.id}`, target: element.id });
    }
  }

  return { nodes, edges };
}
