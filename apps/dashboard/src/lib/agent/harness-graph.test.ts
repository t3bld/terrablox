import {
  HARNESS_ELEMENTS,
  HARNESS_EXTERNALS,
  HARNESS_PLANES,
} from "@terrablox/agent-harness/harness-model";
import { describe, expect, it } from "vitest";

import {
  type AgentContextView,
  buildGraph,
  groupToolsByGroup,
} from "./harness-graph";

/**
 * The harness diagram against the model it is drawn from.
 *
 * The requirement worth a test is a correspondence, not an appearance: every box has to be
 * something the settings panel can open, and every plane has to hang off the spine entry
 * its own model declares. Both were true by inspection only — a hundred and ninety lines of
 * node assembly inside a client component, where a plane could be renamed on one side and
 * silently orphaned on the other.
 *
 * So these assertions read the model rather than a list of expected names. A plane added to
 * `HARNESS_PLANES` is covered the moment it exists, which is the point: the next person to
 * add one should not have to remember to come here.
 */

const context: AgentContextView = {
  scope: "global",
  overridden: [],
  overrides: {},
  model: null,
  reasoningEffort: null,
  turnTimeout: null,
  maxToolCalls: null,
  maxMcpCalls: null,
  historyBudgetChars: null,
  maxSteps: null,
  maxAppRepoReads: null,
  appRepoTreeLimit: null,
  appRepoFileChars: null,
  allowDestructive: false,
  defaults: {
    model: "claude-opus-5",
    reasoningEffort: "high",
    turnTimeout: 1800,
    maxToolCalls: 100,
    maxMcpCalls: 100,
    historyBudgetChars: 24_000,
    maxSteps: 500,
    maxAppRepoReads: 40,
    appRepoTreeLimit: 400,
    appRepoFileChars: 20_000,
  },
  githubConnected: true,
  instructions: "",
  instructionsLength: 0,
  knowledge: [
    {
      id: "project-repository",
      name: "Project",
      description: "",
      enabled: true,
    },
    { id: "module-library", name: "Library", description: "", enabled: true },
    { id: "app-repo", name: "Application", description: "", enabled: false },
  ],
  appRepo: null,
  tools: [
    {
      name: "add_module",
      label: "Add a module",
      summary: "Places a module from the library.",
      group: "Modules",
      enabled: true,
    },
    {
      name: "remove_module",
      label: "Remove a module",
      summary: "Removes it, and every reference to it.",
      group: "Modules",
      enabled: false,
    },
  ],
  mcpServers: [],
  moduleCount: 12,
  projectCount: 3,
};

const graph = buildGraph(context);
const ids = new Set(graph.nodes.map((n) => n.id));

describe("buildGraph", () => {
  it("draws the spine: the provider, the model, the loop", () => {
    // The three the whole diagram hangs off. Everything else attaches to one of them.
    expect(ids.has("provider")).toBe(true);
    expect(ids.has("plane:model")).toBe(true);
    expect(ids.has("plane:loop")).toBe(true);
  });

  it("draws every plane the model declares, and nothing else", () => {
    // Read from the model rather than listed here, so a new plane is covered by existing
    // assertions instead of needing a new one.
    const drawn = graph.nodes
      .filter((n) => n.id.startsWith("plane:"))
      .map((n) => n.id.slice("plane:".length))
      .sort();

    expect(drawn).toEqual(HARNESS_PLANES.map((p) => p.id).sort());
  });

  it("hangs each plane off the entry its own model names", () => {
    // The correspondence that used to hold by inspection: a plane declares its anchor, and
    // the drawing must not decide differently.
    for (const plane of HARNESS_PLANES) {
      const anchor =
        plane.attachesTo === "provider"
          ? "provider"
          : `plane:${plane.attachesTo}`;
      const edge = graph.edges.find((e) => e.target === `plane:${plane.id}`);

      expect(edge, `no edge into ${plane.id}`).toBeDefined();
      expect(edge?.source, `${plane.id} is attached to the wrong entry`).toBe(
        anchor,
      );
    }
  });

  it("leaves no box unreachable from the spine", () => {
    // An orphan is invisible on a canvas that lays itself out: it drifts to a corner and
    // reads as a rendering glitch rather than as a missing edge.
    const reachable = new Set(["provider"]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const edge of graph.edges) {
        if (reachable.has(edge.source) && !reachable.has(edge.target)) {
          reachable.add(edge.target);
          grew = true;
        }
      }
    }
    expect([...ids].filter((id) => !reachable.has(id))).toEqual([]);
  });

  it("gives every box a label, because an unlabelled one says nothing", () => {
    for (const node of graph.nodes) {
      expect(node.label, node.id).toBeTruthy();
    }
  });

  it("names one external, and marks only that one as somebody else's", () => {
    // The model is drawn like the provider even though its choice is ours: it runs there.
    const external = graph.nodes
      .filter((n) => n.kind === "external-module")
      .map((n) => n.id);
    expect(external).toContain("provider");
    expect(HARNESS_EXTERNALS.map((e) => e.id)).toEqual(["provider"]);
  });

  it("reports live numbers on the planes rather than static text", () => {
    // The metadata is what makes the diagram worth looking at twice; a plane showing a
    // constant would be a picture.
    const tools = graph.nodes.find((n) => n.id === "plane:tools-ours");
    expect(JSON.stringify(tools?.metadata)).toContain("1 of 2");
  });

  it("draws a box per connected MCP server, under the MCP plane", () => {
    const withServer = buildGraph({
      ...context,
      mcpServers: [
        {
          id: "srv-1",
          name: "Enginsight",
          url: "https://example.invalid/mcp",
          transport: "http",
          enabled: true,
          headerNames: [],
          tools: null,
          toolsSyncedAt: null,
        },
      ],
    });

    expect(withServer.nodes.some((n) => n.id === "mcp:srv-1")).toBe(true);
    expect(
      withServer.edges.some(
        (e) => e.source === "plane:tools-mcp" && e.target === "mcp:srv-1",
      ),
    ).toBe(true);
  });

  it("keeps a disabled server drawn, because its switch is inside it", () => {
    // The one place this canvas does *not* hide what a turn would not use. Everywhere else
    // it draws only live capability; here the box is the only way to the switch that turns
    // the server back on, so hiding it would hide the way back. The state says which it is.
    const disabled = buildGraph({
      ...context,
      mcpServers: [
        {
          id: "srv-2",
          name: "Off",
          url: "https://example.invalid/mcp",
          transport: "http",
          enabled: false,
          headerNames: [],
          tools: null,
          toolsSyncedAt: null,
        },
      ],
    });

    const node = disabled.nodes.find((n) => n.id === "mcp:srv-2");
    expect(node).toBeDefined();
    expect(JSON.stringify(node?.metadata)).toContain("off");
  });
});

describe("the model behind the diagram", () => {
  it("puts every element on a plane that exists", () => {
    // An element on an unknown plane is one the panel can never show, and the diagram
    // gives no sign of it.
    const planes = new Set(HARNESS_PLANES.map((p) => p.id));
    for (const element of HARNESS_ELEMENTS) {
      expect(
        planes.has(element.plane),
        `${element.id} -> ${element.plane}`,
      ).toBe(true);
    }
  });

  it("keeps every plane inhabited", () => {
    // An empty plane is a box that opens an empty panel.
    for (const plane of HARNESS_PLANES) {
      const inhabited = HARNESS_ELEMENTS.some((e) => e.plane === plane.id);
      // `tools` is the documented exception: it is the three sources beneath it.
      if (plane.id === "tools") continue;
      expect(inhabited, `${plane.id} has no elements`).toBe(true);
    }
  });
});

describe("groupToolsByGroup", () => {
  it("keeps the catalogue's groups rather than inventing any", () => {
    expect(Object.keys(groupToolsByGroup(context.tools))).toEqual(["Modules"]);
  });

  it("keeps a disabled operation in its group, so it can be switched back on", () => {
    expect(groupToolsByGroup(context.tools).Modules).toHaveLength(2);
  });
});
