import {
  KNOWLEDGE_APP_REPO,
  KNOWLEDGE_MODULE_LIBRARY,
  KNOWLEDGE_PROJECT_REPO,
} from "@terrablox/agent-harness/knowledge";
import { describe, expect, it } from "vitest";

import type {
  ProjectGraph,
  ProjectGraphNode,
  ProjectGraphPort,
} from "@/lib/projects/types";
import type { AgentLibraryModule, AgentPort } from "./library-view";
import {
  describeModuleHeading,
  describePorts,
  openInputs,
  pipelineNotice,
  recallConversation,
  systemPrompt,
} from "./prompt";
import type { AgentContext } from "./turn-context";

/**
 * The system prompt, asserted rather than eyeballed.
 *
 * Worth testing because a prompt fails quietly. A wrong sentence here does not throw and
 * does not fail a build — it produces a turn that builds the wrong thing, or apologises for
 * a tool the user themselves switched off, and the only symptom is a model that seems to
 * have got worse. These were five hundred lines inside the turn loop, unreachable from a
 * test because reaching them meant starting a Copilot session.
 *
 * The assertions are about the facts the prompt must state, not its wording: that an empty
 * project is distinguishable from a hidden one, that the three reasons for having no
 * application repository stay three, and that a value the model would need is never merely
 * implied.
 */

function port(name: string, extra: Partial<ProjectGraphPort> = {}) {
  return { name, description: null, ...extra };
}

function moduleNode(
  id: string,
  extra: Partial<ProjectGraphNode> = {},
): ProjectGraphNode {
  return {
    id,
    label: id,
    kind: "module",
    expression: null,
    source: `terraform-aws-modules/${id}/aws`,
    version: "5.1.0",
    sourceKind: "registry",
    file: "main.tf",
    moduleId: id,
    moduleName: `terraform-aws-${id}`,
    exactVersion: true,
    inputs: [],
    outputs: [],
    setArguments: [],
    values: {},
    position: null,
    ...extra,
  };
}

function graph(nodes: ProjectGraphNode[] = []): ProjectGraph {
  return {
    nodes,
    edges: [],
    gaps: [],
    resourceCount: 0,
    files: ["main.tf"],
    sha: "abc123",
    errors: [],
  };
}

/**
 * A library module, which is where a placed module's ports actually come from.
 *
 * `GraphProjection` prefers the library's copy of the ports over the graph node's
 * whenever the node resolves to a module id — the library carries the declared type
 * and the default, the graph only carries enough to draw a box. So a fixture that
 * puts required inputs on the node and leaves the library entry empty describes a
 * module with no inputs at all.
 */
/** A library port, whose `type` is declared rather than optional. */
function libraryPort(name: string, extra: Partial<AgentPort> = {}): AgentPort {
  return { name, description: null, type: null, required: false, ...extra };
}

function libraryModule(
  id: string,
  outputs: string[] = [],
  inputs: AgentPort[] = [],
): AgentLibraryModule {
  return {
    id,
    name: `terraform-aws-${id}`,
    versionTag: "5.1.0",
    description: `The ${id} module.`,
    tags: [],
    inputs,
    outputs: outputs.map((name) => libraryPort(name)),
  };
}

function context(extra: Partial<AgentContext> = {}): AgentContext {
  return {
    projectName: "acme-platform",
    repoFullName: "acme/infra",
    branch: "main",
    graph: graph(),
    library: [],
    history: [],
    userId: "user-1",
    projectId: "project-1",
    githubToken: "gho_secret",
    ...extra,
  };
}

describe("describeModuleHeading", () => {
  it("says the ports are unknown when the library cannot resolve the source", () => {
    const heading = describeModuleHeading({
      id: "legacy",
      moduleName: null,
      version: null,
      exactVersion: false,
    });

    // The absence has to be stated, not left blank: a heading with no ports under
    // it reads exactly like a module that has none.
    expect(heading).toContain("source not in your library");
    expect(heading).toContain("unknown to you");
  });

  it("names the module and version when it resolved", () => {
    expect(
      describeModuleHeading({
        id: "vpc",
        moduleName: "terraform-aws-vpc",
        version: "5.1.0",
        exactVersion: true,
      }),
    ).toBe("- vpc (module terraform-aws-vpc@5.1.0)");
  });

  it("flags a version that is not the pinned one", () => {
    expect(
      describeModuleHeading({
        id: "vpc",
        moduleName: "terraform-aws-vpc",
        version: "5.1.0",
        exactVersion: false,
      }),
    ).toContain("pinned ref not imported");
  });
});

describe("describePorts", () => {
  it("returns nothing for a node with no ports at all", () => {
    expect(describePorts({ inputs: [], outputs: [], values: {} })).toEqual([]);
  });

  it("puts required inputs first, then the ones already carrying a value", () => {
    const [inputs] = describePorts({
      inputs: [
        port("zzz_optional"),
        port("aaa_set"),
        port("required_one", { required: true }),
      ],
      outputs: [],
      values: { aaa_set: "10.0.0.0/16" },
    });

    expect(inputs).toBeDefined();
    const order = ["required_one", "aaa_set", "zzz_optional"].map((name) =>
      (inputs as string).indexOf(name),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order[0]).toBeGreaterThan(-1);
  });

  it("marks required inputs and shows what a set input holds", () => {
    const [inputs] = describePorts({
      inputs: [port("cidr", { required: true, type: "string" })],
      outputs: [],
      values: { cidr: "10.0.0.0/16" },
    });

    expect(inputs).toContain("cidr:string*");
    expect(inputs).toContain("= 10.0.0.0/16");
  });

  it("caps the list and says how many it left out", () => {
    const [inputs, outputs] = describePorts({
      inputs: Array.from({ length: 20 }, (_, i) => port(`in_${i}`)),
      outputs: Array.from({ length: 18 }, (_, i) => port(`out_${i}`)),
      values: {},
    });

    // The cap is only defensible if the model is told to go and get the rest.
    expect(inputs).toContain("+6 more (describe_module)");
    expect(outputs).toContain("+4 more (describe_module)");
  });

  it("says `none` rather than leaving an empty list", () => {
    const [inputs, outputs] = describePorts({
      inputs: [],
      outputs: [port("id")],
      values: {},
    });

    expect(inputs).toContain("inputs (`*` required): none");
    expect(outputs).toContain("outputs: id");
  });
});

describe("pipelineNotice", () => {
  const check = {
    name: "terraform",
    status: "completed",
    conclusion: "success",
    htmlUrl: "https://github.com/acme/infra/actions/runs/1",
    createdAt: "2026-01-01T00:00:00Z",
  };

  it("says nothing when there is no run to report", () => {
    expect(pipelineNotice(null)).toEqual([]);
    expect(pipelineNotice(undefined)).toEqual([]);
  });

  it("refuses to call a still-running configuration validated", () => {
    const lines = pipelineNotice({
      ...check,
      status: "in_progress",
      conclusion: null,
    }).join("\n");

    expect(lines).toContain("still running");
    expect(lines).toContain("do not treat the configuration as validated");
  });

  it("reports a pass as a property of the branch", () => {
    expect(pipelineNotice(check).join("\n")).toContain(
      "formats, initialises and validates",
    );
  });

  it("hands over the run URL and says the log cannot be read", () => {
    const lines = pipelineNotice({
      ...check,
      conclusion: "failure",
    }).join("\n");

    expect(lines).toContain(check.htmlUrl);
    expect(lines).toContain("you cannot read the run's log");
  });
});

describe("recallConversation", () => {
  const history = [
    { role: "user", content: "a".repeat(50) },
    { role: "assistant", content: "b".repeat(50) },
    { role: "user", content: "c".repeat(50) },
  ];

  it("keeps everything when the budget allows and preserves the order", () => {
    const memory = recallConversation(history, 10_000);

    expect(memory.truncated).toBe(false);
    expect(memory.dropped).toBe(0);
    expect(memory.text.indexOf("aaa")).toBeLessThan(memory.text.indexOf("ccc"));
  });

  it("fills backwards, so it is the oldest turns that fall off", () => {
    const memory = recallConversation(history, 130);

    expect(memory.truncated).toBe(true);
    expect(memory.dropped).toBe(1);
    expect(memory.text).not.toContain("aaa");
    expect(memory.text).toContain("ccc");
  });

  it("keeps the newest message whatever its size", () => {
    // Dropping the thing that was just said would be worse than going over budget.
    const memory = recallConversation(
      [{ role: "user", content: "x".repeat(5_000) }],
      10,
    );

    expect(memory.text).toContain("x".repeat(5_000));
    expect(memory.truncated).toBe(false);
  });
});

describe("openInputs", () => {
  it("says plainly when there is nothing left to fill", () => {
    expect(openInputs(context())).toEqual([
      "(nothing unset that anything here could fill)",
    ]);
  });

  const needsVpcId = [
    libraryPort("vpc_id", { required: true, type: "string" }),
  ];

  it("names a module already on the canvas that could supply a missing value", () => {
    const lines = openInputs(
      context({
        graph: graph([moduleNode("vpc"), moduleNode("app")]),
        library: [
          libraryModule("vpc", ["vpc_id"]),
          libraryModule("app", [], needsVpcId),
        ],
      }),
    ).join("\n");

    expect(lines).toContain("app.vpc_id");
    expect(lines).toContain("is required and unset");
    expect(lines).toContain("could come from vpc.vpc_id");
  });

  it("points at a library module to add when nothing on the canvas fits", () => {
    const lines = openInputs(
      context({
        graph: graph([moduleNode("app")]),
        library: [
          libraryModule("app", [], needsVpcId),
          libraryModule("vpc", ["vpc_id"]),
        ],
      }),
    ).join("\n");

    // The path from "vpc_id is missing" to "add the VPC module and wire it" is the
    // whole value of the section.
    expect(lines).toContain("add_module vpc");
  });
});

describe("systemPrompt", () => {
  it("opens by naming the project, repository and branch", () => {
    expect(systemPrompt(context())).toContain(
      'You are the Terrablox agent for the project "acme-platform", backed by acme/infra on branch main',
    );
  });

  it("never prints the credentials the context carries", () => {
    const prompt = systemPrompt(
      context({
        githubToken: "gho_secret",
        appRepo: {
          fullName: "acme/app",
          branch: "main",
          token: "gho_app_secret",
        },
      }),
    );

    expect(prompt).not.toContain("gho_secret");
    expect(prompt).not.toContain("gho_app_secret");
    expect(prompt).toContain("acme/app");
  });

  it("distinguishes a withheld project from an empty one", () => {
    const hidden = systemPrompt(
      context({ disabledKnowledge: [KNOWLEDGE_PROJECT_REPO] }),
    );

    // The failure this guards against: a model reading a hidden project as a new
    // one and building on top of infrastructure it cannot see.
    expect(hidden).toContain("withheld the project's current Terraform");
    expect(hidden).toContain("do not claim the project is empty");
    expect(hidden).not.toContain("## Modules on the canvas");

    expect(systemPrompt(context())).toContain("## Modules on the canvas");
  });

  it("says when the module library was withheld rather than just offering none", () => {
    const hidden = systemPrompt(
      context({
        library: [],
        disabledKnowledge: [KNOWLEDGE_MODULE_LIBRARY],
      }),
    );

    expect(hidden).toContain("withheld the module library");
    expect(hidden).not.toContain("## Module library available to add");
  });

  it("names the tools the user switched off", () => {
    const prompt = systemPrompt(
      context({ disabledTools: ["remove_module", "not_a_real_tool"] }),
    );

    expect(prompt).toContain("switched off these tools");
    expect(prompt).toContain("remove_module");
    // Unknown names are dropped rather than passed through: a typo in the
    // settings must not become a sentence about a tool that never existed.
    expect(prompt).not.toContain("not_a_real_tool");
  });

  it("says nothing about disabled tools when none are", () => {
    expect(systemPrompt(context())).not.toContain("switched off these tools");
  });

  it("tells the three reasons for having no application apart", () => {
    const notLinked = systemPrompt(context());
    expect(notLinked).toContain("No application repository is linked");

    const withheld = systemPrompt(
      context({
        appRepo: { fullName: "acme/app", branch: "main", token: "t" },
        appRepoLink: { fullName: "acme/app" },
        disabledKnowledge: [KNOWLEDGE_APP_REPO],
      }),
    );
    expect(withheld).toContain("withheld it from you");

    const broken = systemPrompt(
      context({
        appRepoLink: { fullName: "acme/app" },
        appRepoProblem: "GitHub returned 404.",
      }),
    );
    expect(broken).toContain("GitHub returned 404.");
    expect(broken).toContain("needs re-picking");

    // Each absence sends the user to a different screen, so no two may read alike.
    expect(new Set([notLinked, withheld, broken]).size).toBe(3);
  });

  it("offers the read tools only when the repository can actually be read", () => {
    expect(
      systemPrompt(
        context({
          appRepo: { fullName: "acme/app", branch: "main", token: "t" },
        }),
      ),
    ).toContain("`list_app_files`");

    expect(systemPrompt(context())).not.toContain("You can read it with");
  });

  it("falls back to names once there are too many modules to list ports for", () => {
    const many = Array.from({ length: 13 }, (_, i) =>
      moduleNode(`m${i}`, { inputs: [port("cidr", { required: true })] }),
    );

    const prompt = systemPrompt(context({ graph: graph(many) }));

    expect(prompt).toContain("Too many modules to list their inputs");
    expect(prompt).not.toContain("inputs (`*` required)");

    const few = systemPrompt(context({ graph: graph(many.slice(0, 3)) }));
    expect(few).toContain("inputs (`*` required)");
    expect(few).not.toContain("Too many modules to list their inputs");
  });

  it("truncates the library and says how to reach the rest", () => {
    const library = Array.from({ length: 130 }, (_, i) =>
      libraryModule(`mod-${i}`),
    );

    const prompt = systemPrompt(context({ library }));

    expect(prompt).toContain("10 more not listed");
    expect(prompt).toContain("describe_module");
  });

  it("states the decisions in force and what they ruled out", () => {
    const prompt = systemPrompt(
      context({
        decisions: [
          {
            id: "d1",
            question: "Which database?",
            choice: "Postgres on RDS",
            reason: "the app speaks SQL",
            rejected: ["DocumentDB"],
          },
        ],
      }),
    );

    expect(prompt).toContain("Decisions this project stands by (1)");
    expect(prompt).toContain("Which database? → Postgres on RDS");
    // The half the prose usually loses, and the reason a settled question does not
    // come back once it has fallen out of the replayed transcript.
    expect(prompt).toContain("ruled out: DocumentDB");
  });

  it("names the connected MCP servers and their shared budget", () => {
    const prompt = systemPrompt(
      context({
        // Only the keys reach the prompt — the tools themselves are registered by
        // the runtime and described by the server — but the config still has to be
        // a real one, so a shape the SDK changed would fail here rather than later.
        mcpServers: {
          enginsight: { type: "http", url: "https://mcp.example" },
        },
        maxMcpCalls: 7,
      }),
    );

    expect(prompt).toContain("## Connected MCP servers");
    expect(prompt).toContain("enginsight");
    expect(prompt).toContain("budget of 7 calls");
  });

  it("puts the user's own instructions after the facts", () => {
    const prompt = systemPrompt(
      context({
        graph: graph([moduleNode("vpc")]),
        instructions: "Prefer Graviton instances.",
      }),
    );

    expect(prompt).toContain("## The user's own instructions");
    expect(prompt.indexOf("## Modules on the canvas")).toBeLessThan(
      prompt.indexOf("## The user's own instructions"),
    );
    expect(prompt).toContain("Prefer Graviton instances.");
  });

  it("admits when the replayed conversation is not the whole of it", () => {
    const prompt = systemPrompt(
      context({
        history: Array.from({ length: 40 }, (_, i) => ({
          role: "user",
          content: `message ${i} `.repeat(20),
        })),
        historyBudgetChars: 400,
      }),
    );

    // A model that cannot see the start of a conversation must not assume it is
    // reading the whole of it.
    expect(prompt).toContain("are not shown");
    expect(prompt).toContain("## Conversation so far");
  });

  it("quotes the operation budget it was given, not the default", () => {
    expect(systemPrompt(context({ maxToolCalls: 3 }))).toContain("3");
  });

  it("prefers the operating rules the caller rendered", () => {
    const prompt = systemPrompt(
      context({ operatingRules: ["Only ever say hello."] }),
    );

    expect(prompt).toContain("Only ever say hello.");
  });
});
