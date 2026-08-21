"use client";

import type {
  DependencyGraphEdge,
  DependencyGraphNode,
} from "@terrablox/graph/dependency-graph";
import { DependencyGraph } from "@terrablox/graph/dependency-graph";
import { Badge } from "@terrablox/ui/badge";
import { Button } from "@terrablox/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@terrablox/ui/card";
import { Label } from "@terrablox/ui/label";
import { Select } from "@terrablox/ui/select";
import { Skeleton } from "@terrablox/ui/skeleton";
import { Textarea } from "@terrablox/ui/textarea";
import { ToggleRow } from "@terrablox/ui/toggle-row";
import { AlertCircle } from "lucide-react";
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
    "tool-budget": { limit: `max ${AGENT_MAX_TOOL_CALLS}` },
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
