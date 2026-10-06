/**
 * The system prompt: the project written out for the model.
 *
 * Split from the turn loop because it is a different kind of code doing a
 * different job. This side is a pure function of `AgentContext` — no network, no
 * database, no session — so what the model is told can be asserted in a test,
 * which is the only way to keep a prompt honest as it grows. The loop decides
 * what to do; this decides what is known.
 *
 * No `server-only` marker, unlike the loop: nothing here fetches a credential.
 * The context arrives already filled in, so the secrets in it are the caller's
 * and this module only ever declines to print them.
 */

import type { MCPServerConfig } from "@github/copilot-sdk";
import {
  KNOWLEDGE_APP_REPO,
  KNOWLEDGE_MODULE_LIBRARY,
  KNOWLEDGE_PROJECT_REPO,
  knowledgeEnabled,
} from "@terrablox/agent-harness/knowledge";
import {
  AGENT_HISTORY_BUDGET_CHARS,
  AGENT_MAX_MCP_CALLS,
  AGENT_MAX_TOOL_CALLS,
  DEFAULT_OPERATING_RULES,
  renderOperatingRule,
} from "@terrablox/agent-harness/runtime-options";
import { isKnownTool } from "@terrablox/agent-harness/tool-catalogue";
import { GraphProjection } from "./graph-projection";
import { summariseLibraryModule } from "./library-view";
import type { AgentContext, AgentPipelineCheck } from "./turn-context";

/**
 * How many placed modules get their ports written out in the prompt.
 *
 * The ports are the point of the section — without them the agent cannot see that
 * an optional input exists, so it can never set one. But a project with forty
 * modules would spend the whole prompt on them, so past this many the list falls
 * back to names and the agent is told to use `describe_module`.
 */
const PROMPT_PORT_MODULES = 12;

/** How many of one module's ports the prompt lists before pointing elsewhere. */
const PROMPT_PORTS_PER_MODULE = 14;

/** How many library modules the prompt lists in full before truncating. */
const PROMPT_LIBRARY_LIMIT = 120;

/**
 * Why there is no application to read, in the terms of whoever has to fix it.
 *
 * Reached only when `appRepo` is absent, and its job is to say *which* absence
 * this is. All three used to collapse into two sentences, and the missing one was
 * the worst of them: a link whose repository has been renamed or whose access
 * lapsed reads, from inside the prompt, exactly like a link that works — so the
 * agent would report that the application says nothing about its own runtime.
 */
function unreadableAppRepoNotice(
  context: AgentContext,
  withheld: boolean,
): string[] {
  const link = context.appRepoLink ?? context.appRepo;

  if (!link) {
    return [
      "No application repository is linked to this project, so you cannot see the application's code. Ask the user what runs on this infrastructure — runtime, ports, data stores, how it is deployed — rather than assuming, and mention that linking a repository in the agent settings would let you read it yourself.",
    ];
  }

  // Checked before the broken-link case even though both may be true at once. A
  // user who switched this off has to switch it back on before anything else
  // matters, and sending them to re-pick a repository would be advice about a
  // problem they cannot see the effect of.
  if (withheld) {
    return [
      `This project is linked to ${link.fullName}, but the user has withheld it from you: you cannot read the application's code in this turn. Say that application repository access is switched off in the agent settings, and ask them about the application instead of assuming.`,
    ];
  }

  return [
    `This project is linked to ${link.fullName}, but it cannot be read: ${
      context.appRepoProblem ?? "GitHub did not return it."
    }`,
    "Trying again will not help. Tell the user the link is broken and needs re-picking in the agent settings, then ask them about the application directly.",
  ];
}

/**
 * What is still open on this canvas, before the turn has done anything.
 *
 * Replaces a section headed "Unset required inputs" that was fed from
 * `graph.gaps` and, on any real catalogue, always said `(none)`: gaps are
 * required inputs, and 324 of the 372 imported modules declare no required
 * variable — every upstream module defaults them. So the agent was told a stack
 * with nothing wired together had nothing left to do, and had no reason to
 * disbelieve it.
 *
 * Computed from a projection with nothing queued, which is the same code
 * `review_project` answers from. The agent should not have to make a tool call to
 * find out that the project it was handed is unfinished.
 */
export function openInputs(context: AgentContext): string[] {
  const projection = new GraphProjection(context.graph, context.library);
  const gaps = projection.gaps();
  const unwired = projection.unwiredInputs();

  if (gaps.length === 0 && unwired.length === 0) {
    return ["(nothing unset that anything here could fill)"];
  }

  return [
    // Both halves of a gap, not just the first. `candidates` — library modules
    // that would produce the missing value once added — is the path from "vpc_id
    // is missing" to "add the VPC module and wire it".
    ...gaps.map((gap) => {
      const sources = [
        ...gap.wirable.map((w) => `${w.node}.${w.output}`),
        ...gap.candidates.map(
          (c) => `${c.name}.${c.output} (add_module ${c.moduleId})`,
        ),
      ];

      return `- ${gap.node}.${gap.input}${gap.type ? ` (${gap.type})` : ""} is required and unset${
        sources.length ? `; could come from ${sources.join(" or ")}` : ""
      }`;
    }),
    ...unwired.map((entry) =>
      entry.kind === "wirable"
        ? `- ${entry.module}.${entry.input} is unset; ${entry.sources[0]} fits it by name (auto_connect ${entry.module})`
        : `- ${entry.module}.${entry.input} is unset, so ${entry.module} is in no network; candidates ${entry.sources.join(" or ")} — pick one or ask`,
    ),
  ];
}

/**
 * The decisions this project stands by, and what they ruled out.
 *
 * Cheap and load-bearing. Without it the only memory a turn has is the replayed
 * transcript, filled backwards into a character budget — so the answer to "managed
 * document database?" was settled once, fell out of the window, and would be
 * proposed again by a turn with no way to know. Five lines here outlast twenty
 * turns of conversation.
 *
 * The rejected options are listed because that is the half the prose usually
 * loses: a reply says what was built, and rarely says what was considered and why
 * it lost.
 */
function decisionsInForce(context: AgentContext): string[] {
  const decisions = context.decisions ?? [];
  if (decisions.length === 0) return [];

  return [
    `## Decisions this project stands by (${decisions.length})`,
    "Yours and the user's, from earlier turns. Build on them rather than re-opening",
    "them, and if one is now wrong say so and record a new decision that supersedes",
    "it — do not quietly do something else.",
    ...decisions.map((decision) =>
      [
        `- [${decision.id}] ${decision.question} → ${decision.choice}`,
        `  because ${decision.reason}`,
        ...(decision.rejected.length
          ? [`  ruled out: ${decision.rejected.join("; ")}`]
          : []),
      ].join("\n"),
    ),
    "",
  ];
}

/**
 * The project, written out for the model.
 *
 * The graph is small and already loaded, so handing it over up front is
 * cheaper and more reliable than giving the model read tools and hoping it
 * asks the right questions.
 */
export function systemPrompt(context: AgentContext): string {
  const { graph } = context;

  const hasLibrary = knowledgeEnabled(
    context.disabledKnowledge,
    KNOWLEDGE_MODULE_LIBRARY,
  );
  const hasRepo = knowledgeEnabled(
    context.disabledKnowledge,
    KNOWLEDGE_PROJECT_REPO,
  );
  const appRepo =
    context.appRepo &&
    knowledgeEnabled(context.disabledKnowledge, KNOWLEDGE_APP_REPO)
      ? context.appRepo
      : null;

  const moduleNodes = graph.nodes.filter((node) => node.kind === "module");
  const localNodes = graph.nodes.filter((node) => node.kind === "local");

  // With the ports, which is the difference between a list of boxes and a
  // configuration. Without them the agent could only ever set the inputs that
  // happened to appear as gaps — every optional input was invisible, so
  // `enable_nat_gateway` or `instance_type` could not be set even when the user
  // asked for it by name.
  const modules = moduleNodes.length
    ? moduleNodes
        .map((node) =>
          moduleNodes.length > PROMPT_PORT_MODULES
            ? describeModuleHeading(node)
            : [describeModuleHeading(node), ...describePorts(node)].join("\n"),
        )
        .join("\n")
    : "(none)";

  const locals = localNodes.length
    ? localNodes
        .map((node) => `- local.${node.id} = ${node.expression ?? "(unset)"}`)
        .join("\n")
    : "(none)";

  const wiring = graph.edges.length
    ? graph.edges
        .flatMap((edge) =>
          edge.links.map((link) =>
            edge.sourceKind === "local"
              ? `- ${edge.target}.${link.targetInput} = local.${edge.source}`
              : `- ${edge.target}.${link.targetInput} = ${edge.source}.${link.sourceOutput ?? "?"}`,
          ),
        )
        .join("\n")
    : "(nothing wired up)";

  const shownLibrary = context.library.slice(0, PROMPT_LIBRARY_LIMIT);
  const library = context.library.length
    ? [
        ...shownLibrary.map(summariseLibraryModule),
        ...(context.library.length > shownLibrary.length
          ? [
              `(${context.library.length - shownLibrary.length} more not listed. Ask for one by name with describe_module.)`,
            ]
          : []),
      ].join("\n")
    : "(empty)";

  // Last few turns only. The graph above already reflects everything earlier
  // turns changed, so older messages add tokens without adding facts.
  const memory = recallConversation(
    context.history,
    context.historyBudgetChars ?? AGENT_HISTORY_BUDGET_CHARS,
  );

  return [
    `You are the Terrablox agent for the project "${context.projectName}", backed by ${context.repoFullName} on branch ${context.branch}.`,
    "",
    // Editable in the admin panel, defaults in `harness-curation`. Rendered
    // there, so a rule quoting the operation budget cannot quote a wrong one.
    ...(context.operatingRules ??
      DEFAULT_OPERATING_RULES.map((rule) =>
        renderOperatingRule(rule, context.maxToolCalls ?? AGENT_MAX_TOOL_CALLS),
      )),
    // Named explicitly, because otherwise the model reads a missing tool as its
    // own failure and apologises instead of telling the user where the switch is.
    ...disabledToolNotice(context.disabledTools),
    // Same reasoning for knowledge, and one degree more important: an empty
    // project and a hidden project look identical from inside the prompt, and
    // only one of them is safe to start building on.
    ...withheldKnowledgeNotice(hasLibrary, hasRepo),
    "",
    ...(hasRepo
      ? [
          `## Modules on the canvas (${moduleNodes.length})`,
          modules,
          ...(moduleNodes.length > PROMPT_PORT_MODULES
            ? [
                "",
                "Too many modules to list their inputs and outputs here. Use `describe_module`",
                "on the ones you need to change or wire.",
              ]
            : []),
          "",
          `## Variables, i.e. \`locals\` (${localNodes.length})`,
          locals,
          "",
          "A variable is the right answer when an input needs a constant, when the same",
          "constant is needed in two places, or when a computed expression deserves a",
          "name. Wiring one module's output straight into another module's input needs",
          "no variable in between.",
          "",
          "## Wiring",
          wiring,
          "",
          "## Inputs still to decide",
          ...openInputs(context),
          "",
          ...decisionsInForce(context),
          `Root-level resource/data blocks: ${graph.resourceCount}. Files: ${graph.files.join(", ") || "none"}.`,
          "",
          // The rule the canvas wires by, stated rather than left to be inferred
          // from examples. The agent was previously shown the *results* of this
          // scoring for required inputs and never the principle, so it had no way
          // to apply it to an optional input or to a module it had just added.
          "## How values fit together",
          "Terraform types every id as a string, so the only reliable signal is the naming",
          "convention modules follow: an output called `vpc_id` belongs in an input called",
          "`vpc_id`, and a module named `vpc` with an output `id` fits an input `vpc_id`.",
          "Anything weaker than that is a guess — and a wrong wire is silent, because it",
          "plans, applies, and builds the wrong thing. When two modules could both supply a",
          "value, ask which one rather than picking.",
        ]
      : []),
    ...(hasLibrary
      ? [
          "",
          `## Module library available to add (${context.library.length})`,
          "One line each: id, name, what it is, and how many ports it has. `add_module` takes",
          "the id. Before wiring a module you have not used in this conversation, call",
          "`describe_module` — it returns every input with its type and default, every output,",
          "and which of its resources bill by the hour. Guessing an output name writes a",
          "reference that only fails when somebody runs Terraform.",
          library,
        ]
      : []),
    // Placed after the project because it is a statement about the project, and
    // before the application because it may be the reason this turn exists.
    ...pipelineNotice(context.lastCheck),
    // Placed after the project and the library, because it is the only section
    // that asks the model to go and do something before answering rather than
    // telling it something. It reads as an instruction, and an instruction wants
    // the facts above it already in view.
    ...(appRepo
      ? [
          "",
          "## The application this infrastructure is for",
          `Linked repository: ${appRepo.fullName}, branch ${appRepo.branch}. You can read it with \`list_app_files\` and \`read_app_file\`, and you cannot write to it.`,
          "",
          "Read it before proposing infrastructure. What an application needs is a fact about",
          "how it is built, not a preference to be guessed at: its language and framework,",
          "whether it ships a container, which ports it listens on, which databases, caches,",
          "queues and buckets it talks to, what its configuration and secrets look like, and",
          "how it is currently built and deployed. Start with `list_app_files`, then read the",
          "files that state requirements — Dockerfile, compose files, dependency manifests,",
          "environment samples, CI workflows — rather than reading the whole repository.",
          "",
          "Say what you found and what you concluded from it, so the user can correct a wrong",
          "reading before it becomes infrastructure. If the repository turns out not to answer",
          "the question, ask them instead of assuming.",
        ]
      : [
          "",
          "## The application this infrastructure is for",
          // Three reasons for having no application to read, and a person fixes
          // each of them somewhere else: the agent settings, GitHub, or the link
          // itself. Saying "not linked" to someone who switched it off themselves
          // sends them to the wrong screen, and saying it to someone whose
          // repository was renamed sends them to a screen that looks correct.
          ...unreadableAppRepoNotice(
            context,
            !knowledgeEnabled(context.disabledKnowledge, KNOWLEDGE_APP_REPO),
          ),
        ]),
    // Beside the application repository rather than up with the operations,
    // because it is the same kind of section: somewhere to go and look before
    // answering, not a fact about the project.
    ...mcpNotice(
      context.mcpServers,
      context.maxMcpCalls ?? AGENT_MAX_MCP_CALLS,
    ),
    // The user's own instructions come last, after the facts, so
    // they read as standing preferences rather than as part of the graph.
    ...(context.instructions?.trim()
      ? [
          "",
          "## The user's own instructions",
          "Follow these unless they conflict with the rules above.",
          context.instructions.trim(),
        ]
      : []),
    ...(memory.text
      ? [
          "",
          "## Conversation so far",
          // Said out loud, because a model that cannot see the start of a
          // conversation should not assume it is reading the whole of it.
          ...(memory.truncated
            ? [
                `(The earliest ${memory.dropped} message(s) are not shown — this conversation is longer than fits here.)`,
              ]
            : []),
          memory.text,
        ]
      : []),
  ].join("\n");
}

/** `- vpc (module terraform-aws-vpc@5.1.0)`, or just the label when unresolved. */
export function describeModuleHeading(node: {
  id: string;
  moduleName: string | null;
  version: string | null;
  exactVersion: boolean;
}): string {
  if (!node.moduleName) {
    // Worth saying rather than leaving blank: a block the library cannot resolve
    // has no ports here, so the agent must not read the absence as "no inputs".
    return `- ${node.id} (source not in your library — its inputs and outputs are unknown to you)`;
  }

  return `- ${node.id} (module ${node.moduleName}${node.version ? `@${node.version}` : ""}${
    node.exactVersion ? "" : ", pinned ref not imported"
  })`;
}

/**
 * A placed module's ports, with the set ones showing what they hold.
 *
 * Set arguments carry their expression because that is what makes the difference
 * between "this input has a value" and "this input has the *right* value" — and
 * changing one is an edit the agent could not previously see the need for.
 */
export function describePorts(node: {
  inputs: Array<{ name: string; required?: boolean; type?: string | null }>;
  outputs: Array<{ name: string }>;
  values: Record<string, string>;
}): string[] {
  if (node.inputs.length === 0 && node.outputs.length === 0) return [];

  const inputs = [...node.inputs]
    // Required first, then the ones already carrying a value: those are the two
    // kinds worth reading when the list has to be cut short.
    .sort(
      (a, b) =>
        Number(b.required ?? false) - Number(a.required ?? false) ||
        Number(node.values[b.name] !== undefined) -
          Number(node.values[a.name] !== undefined) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, PROMPT_PORTS_PER_MODULE)
    .map((input) => {
      const value = node.values[input.name];
      return `${input.name}${input.type ? `:${input.type}` : ""}${
        input.required ? "*" : ""
      }${value !== undefined ? ` = ${truncate(value, 60)}` : ""}`;
    });

  const hiddenInputs = node.inputs.length - inputs.length;

  const lines = [
    `  inputs (\`*\` required): ${inputs.join(", ") || "none"}${
      hiddenInputs > 0 ? `, +${hiddenInputs} more (describe_module)` : ""
    }`,
  ];

  const outputs = node.outputs
    .slice(0, PROMPT_PORTS_PER_MODULE)
    .map((output) => output.name);
  const hiddenOutputs = node.outputs.length - outputs.length;

  lines.push(
    `  outputs: ${outputs.join(", ") || "none"}${
      hiddenOutputs > 0 ? `, +${hiddenOutputs} more (describe_module)` : ""
    }`,
  );

  return lines;
}

function truncate(value: string, max: number): string {
  const flat = value.trim().replace(/\s+/g, " ");
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * What the pipeline made of the last commit.
 *
 * The only verdict on this configuration from a real Terraform: the project's own
 * workflow runs `fmt -check`, `init` and `validate`, minutes after a commit and
 * outside any turn. It cannot be waited for, so it arrives as a fact about the
 * previous turn — which is precisely when it is worth acting on, because the code
 * that failed is still the code in front of the agent.
 */
export function pipelineNotice(
  check: AgentPipelineCheck | null | undefined,
): string[] {
  if (!check) return [];

  const lines = ["", "## Last pipeline run on this branch"];

  if (check.status !== "completed") {
    lines.push(
      `\`${check.name}\` is still running (${check.status}). Its verdict on the previous commit is not in yet, so do not treat the configuration as validated.`,
    );
    return lines;
  }

  if (check.conclusion === "success") {
    lines.push(
      `\`${check.name}\` passed, so the configuration on this branch formats, initialises and validates. Keep it that way.`,
    );
    return lines;
  }

  lines.push(
    `\`${check.name}\` ended as \`${check.conclusion ?? "unknown"}\`. Terraform is not happy with what is on this branch: ${check.htmlUrl}.`,
    "If the user is asking about something else, mention it once and carry on. If they are asking you to fix it, work out which module or value is wrong from the graph above — you cannot read the run's log — and say what you think it is before changing anything.",
  );

  return lines;
}

/**
 * The project's conversation, newest-first until the budget runs out.
 *
 * One memory per project, holding as much of its own history as can be carried.
 * Filling backwards is what makes the limit bite in the right place: the turns
 * that matter to the question being asked are the recent ones, and it is the
 * opening small talk that gets dropped.
 */
export function recallConversation(
  history: Array<{ role: string; content: string }>,
  budgetChars: number,
): {
  text: string;
  truncated: boolean;
  dropped: number;
} {
  const lines: string[] = [];
  let used = 0;
  let taken = 0;

  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (!entry) continue;

    const line = `${entry.role}: ${entry.content}`;
    // The newest message is kept whatever its size: dropping the thing that was
    // just said would be worse than a slightly over-budget prompt.
    if (used + line.length > budgetChars && taken > 0) break;

    lines.push(line);
    used += line.length + 1;
    taken++;
  }

  lines.reverse();

  return {
    text: lines.join("\n"),
    truncated: taken < history.length,
    dropped: history.length - taken,
  };
}

/**
 * Tells the model which facts it is missing, and that they were withheld.
 *
 * Silence would be worse than absence here. With no project in the prompt the
 * model has no way to tell "this repository is empty" from "you are not allowed
 * to see this repository", and the first reading leads it to propose building a
 * stack from scratch on top of one that already exists.
 */
function withheldKnowledgeNotice(
  hasLibrary: boolean,
  hasRepo: boolean,
): string[] {
  const lines: string[] = [];

  if (!hasRepo) {
    lines.push(
      "The user has withheld the project's current Terraform from you. You cannot see which modules, values or wiring already exist, so do not claim the project is empty and do not change or remove anything you cannot see. Say that repository knowledge is switched off in the agent settings, and offer only what is safe without it.",
    );
  }

  if (!hasLibrary) {
    lines.push(
      "The user has withheld the module library from you, so you cannot add modules at all. If asked for one, say the module library is switched off in the agent settings.",
    );
  }

  return lines;
}

/**
 * Names the MCP servers whose tools are on the session.
 *
 * The tools themselves are registered by the runtime, described by the server,
 * and never pass through our catalogue — so without this the model is handed a
 * set of tools with no idea why they are there or what they are for. The names
 * are what makes them usable: `enginsight` next to a question about Enginsight is
 * the whole hint, and a model that cannot see the connection between the two
 * searches the module library instead.
 *
 * Deliberately not listing the individual tools. We do not know them: the server
 * decides, it may change them between turns, and the runtime has already put
 * their real descriptions in front of the model.
 */
function mcpNotice(
  servers: Record<string, MCPServerConfig> | undefined,
  maxMcpCalls: number,
): string[] {
  const names = Object.keys(servers ?? {});
  if (!names.length) return [];

  return [
    "",
    "## Connected MCP servers",
    `The user has connected: ${names.join(", ")}. Their tools are on your tool list beside your own operations, and what each one does is in its own description.`,
    "",
    "They are somebody else's servers, so treat them the way you treat the application",
    `repository: a place to look something up before answering, not a place to guess at. There is a budget of ${maxMcpCalls} calls for the whole turn, so search deliberately rather than repeatedly. Say which server an answer came from — the user connected it and can judge the source, which they cannot do if you present it as your own knowledge.`,
  ];
}

/** Tells the model a capability was withheld by the user, not lost to a bug. */
function disabledToolNotice(disabled: string[] | undefined): string[] {
  const names = (disabled ?? []).filter(isKnownTool);
  if (!names.length) return [];

  return [
    `The user has switched off these tools for this project: ${names.join(", ")}. You do not have them. If asked for one, say it is disabled in the agent settings and offer the closest thing you can still do.`,
  ];
}
