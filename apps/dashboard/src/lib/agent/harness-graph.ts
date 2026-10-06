/**
 * The harness screen's data: what the endpoint answers with, and the diagram drawn from it.
 *
 * Extracted from `agent-harness.tsx`, which was 2205 lines of which these were the part
 * with no JSX in it. Two reasons, and the second is the real one.
 *
 * `AgentContextView` is the contract of `/api/agent/context`, so a component was the wrong
 * place to state it — the route and the screen have to agree, and neither should have to
 * read the other to find out how.
 *
 * `buildGraph` is the requirement this file exists to protect. Every box in the diagram has
 * to correspond to a settings control, and every plane has to hang off the spine entry its
 * own model declares. That was true by inspection and by nothing else: it is a hundred and
 * ninety lines of node assembly inside a client component, which no test could reach. Out
 * here it is a pure function of one argument, and `harness-graph.test.ts` asserts the
 * correspondence rather than trusting it.
 */

import {
  HARNESS_EXTERNALS,
  HARNESS_PLANES,
  type HarnessAnchor,
} from "@terrablox/agent-harness/harness-model";
import type {
  DependencyGraphEdge,
  DependencyGraphNode,
} from "@terrablox/graph/dependency-graph";

/**
 * What a box belongs to when it is not ours.
 *
 * "Third party" rather than "outside the harness", because it says whose it is
 * instead of only where it is not: the provider, the model running on it, and every
 * MCP server somebody connects are all systems we neither host nor control.
 */
export const THIRD_PARTY = "Third party";

export const TOOL_GROUP_LABELS: Record<string, string> = {
  library: "Module library",
  review: "Planning and review",
  modules: "Modules",
  locals: "Variables",
  "app-repo": "Application repository",
};

export type ToolView = {
  name: string;
  group: string;
  label: string;
  summary: string;
  enabled: boolean;
};

export function groupToolsByGroup(
  tools: ToolView[],
): Record<string, ToolView[]> {
  const groups: Record<string, ToolView[]> = {};
  for (const tool of tools) {
    const key = tool.group;
    if (!groups[key]) groups[key] = [];
    groups[key].push(tool);
  }
  return groups;
}

/** One tool of a connected MCP server, as the server described it. */
export type McpToolRow = {
  name: string;
  title: string;
  description: string;
  /** The server's own annotation, shown as its claim rather than as a fact. */
  readOnly: boolean;
  enabled: boolean;
};

/**
 * One connected MCP server.
 *
 * `headerNames` and no header values: they are the credential the requests are
 * made with, encrypted at rest, and the server never sends them back. The names
 * are enough to answer the only question the screen has to answer — whether this
 * connection authenticates itself, and with which header.
 *
 * `tools` is null when we have never managed to ask the server what it has, which
 * is a different state from a server with no tools and is shown differently.
 */
export type McpServerRow = {
  id: string;
  name: string;
  url: string;
  transport: "http" | "sse";
  enabled: boolean;
  headerNames: string[];
  tools: McpToolRow[] | null;
  toolsSyncedAt: string | null;
};

export interface AgentContextView {
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
  /** Operations one turn may queue, and MCP calls it may make. Null → default. */
  maxToolCalls: number | null;
  maxMcpCalls: number | null;
  /** Characters of this project's conversation replayed. Null → default. */
  historyBudgetChars: number | null;
  /** Entries of one turn recorded. Null → default. */
  maxSteps: number | null;
  /** How far a turn may read into the linked application. Null → default. */
  maxAppRepoReads: number | null;
  appRepoTreeLimit: number | null;
  appRepoFileChars: number | null;
  /** Whether the agent may delete modules and variables. */
  allowDestructive: boolean;
  /** What a null choice above resolves to, so the UI can name it. */
  defaults: {
    model: string;
    reasoningEffort: string;
    turnTimeout: number;
    maxToolCalls: number;
    maxMcpCalls: number;
    historyBudgetChars: number;
    maxSteps: number;
    maxAppRepoReads: number;
    appRepoTreeLimit: number;
    appRepoFileChars: number;
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

/**
 * The harness as a drawing: the provider, the model, and the planes.
 *
 * The provider is not a plane and is not ours — it is where inference comes from,
 * drawn above because everything below answers inside a call to it. Everything
 * under the model is the harness.
 *
 * Every box takes its label from the same catalogue the cards render, so a box and
 * a heading cannot say different things. Only planes are drawn: an element is
 * reached by clicking the plane it is on, which opens the very same control the
 * card below holds.
 */
export function buildGraph(context: AgentContextView): {
  nodes: DependencyGraphNode[];
  edges: DependencyGraphEdge[];
} {
  const enabledTools = context.tools.filter((tool) => tool.enabled);
  const enabledServers = context.mcpServers.filter((server) => server.enabled);
  /** Roomier than the default so a description is not clipped. */
  const box = { width: 320, height: 152 } as const;

  const provider = HARNESS_EXTERNALS.find((entry) => entry.id === "provider");

  const nodes: DependencyGraphNode[] = [];
  const edges: DependencyGraphEdge[] = [];

  // The spine: provider, model, agent loop. Every plane hangs off one of the
  // three, and which one is declared on the plane rather than decided here — so
  // the drawing cannot disagree with the placement the cards state.
  if (provider) {
    nodes.push({
      id: "provider",
      label: provider.label,
      kind: "external-module",
      group: THIRD_PARTY,
      description: context.githubConnected
        ? provider.brief
        : "Not connected, so no turn can run.",
      metadata: {
        status: context.githubConnected ? "connected" : "not connected",
      },
      ...box,
    });
  }

  /**
   * Where a plane's box hangs from.
   *
   * An external id is a node id already; a plane id has to be prefixed. Nothing
   * is special-cased: the model used to be a bare node here with the planes wired
   * to it by hand, which meant its own settings had nowhere to live.
   */
  const anchorOf = (anchor: HarnessAnchor) =>
    HARNESS_EXTERNALS.some((entry) => entry.id === anchor)
      ? anchor
      : `plane:${anchor}`;

  /**
   * What each plane box says at a glance.
   *
   * The boxes below a plane used to be its elements, one node each, which put
   * roughly thirty cards on the canvas and made a diagram nobody could read — and
   * every one of them duplicated a heading in the card underneath. The plane box
   * now carries the numbers instead and the panel carries the detail, so the
   * drawing is a map and the reading happens where there is room for it.
   *
   * Two entries per box at most: the node renderer shows the first two, so a third
   * would be written and never seen.
   */
  const planeMetadata: Record<string, Record<string, string | number>> = {
    model: {
      model: context.model ?? `default (${context.defaults.model})`,
      effort:
        context.reasoningEffort ??
        `default (${context.defaults.reasoningEffort})`,
    },
    loop: {
      timeout: `${context.turnTimeout ?? context.defaults.turnTimeout}s`,
      budgets: `${context.maxToolCalls ?? context.defaults.maxToolCalls} operations · ${
        context.maxMcpCalls ?? context.defaults.maxMcpCalls
      } MCP calls`,
    },
    context: {
      sources: `${context.knowledge.filter((source) => source.enabled).length} of ${context.knowledge.length} on`,
      // Named rather than counted: which application it may read is the fact, and
      // "none" is a real answer rather than a missing one.
      application: context.appRepo?.fullName ?? "no application linked",
      reads: `${context.maxAppRepoReads ?? context.defaults.maxAppRepoReads} per turn`,
    },
    tools: {
      namespaces: "custom · mcp · builtin",
      registered: `${enabledTools.length} of ours, ${enabledServers.length} server(s)`,
    },
    "tools-ours": {
      allowed: `${enabledTools.length} of ${context.tools.length}`,
      queued: "every edit, then one commit",
    },
    "tools-mcp": {
      // The enabled count, not the stored one: a server that is off is not on the
      // session, so counting it would draw a capability nobody has.
      servers: `${enabledServers.length} of ${context.mcpServers.length} enabled`,
      tools: enabledServers.length
        ? enabledServers
            .map(
              (server) =>
                `${server.name} (${
                  server.tools
                    ? `${server.tools.filter((tool) => tool.enabled).length} tools`
                    : "all tools"
                })`,
            )
            .join(", ")
        : "nothing enabled",
    },
    "tools-runtime": {
      taken: "none",
      namespace: "builtin: never on the allow list",
    },
    guardrails: {
      deleting: context.allowDestructive ? "allowed" : "not allowed",
      checked: "every call, before it takes effect",
    },
    memory: {
      conversation: `~${Math.round((context.historyBudgetChars ?? context.defaults.historyBudgetChars) / 1000)}k characters replayed`,
      runtime: "session deleted per turn",
    },
    observability: {
      steps: `up to ${context.maxSteps ?? context.defaults.maxSteps} recorded`,
      history: `${context.projectCount} project(s) with a commit log`,
    },
  };

  for (const meta of HARNESS_PLANES) {
    // The model is drawn like the provider, not like our own parts, because that
    // is where it runs — we host nothing and cannot see inside it. It still has a
    // box with settings, because the *choice* of model is ours even though the
    // model is not; the two halves are different things and the colour says which
    // is which. The loop is the other spine box, and that one is ours.
    const outside = meta.id === "model";

    nodes.push({
      id: `plane:${meta.id}`,
      label: meta.label,
      kind: outside ? "external-module" : "module",
      // Two categories and no third: either it is somebody else's system or it
      // is part of the harness. "Plane" used to sit here as a category of its
      // own, which said nothing — everything that is not third party is the
      // harness, so the pill was a word where a fact belonged.
      group: outside ? THIRD_PARTY : "Harness",
      description: meta.summary,
      metadata: planeMetadata[meta.id],
      ...box,
    });
    edges.push({
      source: anchorOf(meta.attachesTo),
      target: `plane:${meta.id}`,
    });
  }

  // A connected server is an outside system the user brought in, so it is drawn
  // like the provider rather than like one of our parts: its own box, its own
  // colour, reachable in one click. It is also the only place on this canvas where
  // a box comes from data rather than from the catalogue — the catalogue cannot
  // know how many servers somebody connected.
  //
  // Disabled ones are drawn too, with their state in the metadata. Elsewhere this
  // canvas hides what a turn would not use, but a server that is off has to stay
  // clickable: the switch that turns it on is inside its own panel, and hiding the
  // box would hide the way to it.
  for (const server of context.mcpServers) {
    nodes.push({
      id: `mcp:${server.id}`,
      label: server.name,
      kind: "external-module",
      group: THIRD_PARTY,
      description: server.enabled
        ? "Its enabled tools are on the session for every pass."
        : "Connected but switched off, so none of its tools are offered.",
      metadata: {
        state: server.enabled ? "enabled" : "off",
        tools: server.tools
          ? `${server.tools.filter((tool) => tool.enabled).length} of ${server.tools.length} on`
          : "not read yet",
      },
      ...box,
    });
    edges.push({ source: "plane:tools-mcp", target: `mcp:${server.id}` });
  }

  return { nodes, edges };
}
