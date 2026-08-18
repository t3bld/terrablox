import "server-only";

import {
  type CopilotSession,
  defineTool,
  type MCPServerConfig,
} from "@github/copilot-sdk";

import type {
  AgentStep,
  ProjectGraph,
  ProjectGraphMutation,
} from "@/lib/projects/types";

import {
  COPILOT_MODEL,
  copilotClient,
  describeCopilotError,
  discardCopilotClient,
} from "./copilot";
import type { ReasoningEffortValue } from "./settings-service";
import type { AgentSkill } from "./skills";
import { isKnownTool, PROJECT_AGENT_TOOLS } from "./tool-catalogue";

/**
 * The project agent.
 *
 * The agent's only way to change a project is the same mutation set the canvas
 * uses, so whatever it does arrives in the repository through one code path and
 * shows up in the graph exactly like a manual edit. The model is Copilot,
 * running on the signed-in user's own subscription.
 */

/** Tool definitions, in the shape function-calling APIs expect. */
export { PROJECT_AGENT_TOOLS } from "./tool-catalogue";

export interface AgentContext {
  projectName: string;
  repoFullName: string;
  branch: string;
  graph: ProjectGraph;
  library: Array<{ id: string; name: string; versionTag: string | null }>;
  history: Array<{ role: string; content: string }>;
  /** Identifies the Copilot session; the turn runs as this user. */
  userId: string;
  projectId: string;
  /** The user's GitHub token, which is also what pays for the turn. */
  githubToken: string;
  /** What this user told the agent about how they work. */
  instructions?: string;
  /** Skills this user switched on, already resolved to their content. */
  skills?: AgentSkill[];
  /** Remote MCP servers this user enabled, decrypted and ready to use. */
  mcpServers?: Record<string, MCPServerConfig>;
  /** Copilot model id, or null to let Copilot choose. */
  model?: string | null;
  /**
   * How hard the model should think, when it supports the setting. Typed from
   * our own validated union because the SDK declares `ReasoningEffort` but does
   * not re-export it from the package root.
   */
  reasoningEffort?: ReasoningEffortValue | null;
  /** Tools the agent may not call in this project. */
  disabledTools?: string[];
}

export interface AgentTurn {
  reply: string;
  /** Mutations to apply, in order. Empty when the turn only answers. */
  mutations: ProjectGraphMutation[];
  /** How the turn got to its answer, in the order it happened. */
  steps: AgentStep[];
}

/**
 * Caps on the recorded trail.
 *
 * The steps are stored on the message and sent to every client that loads the
 * transcript, so a model that thinks in essays must not be able to grow a row
 * without bound.
 */
const MAX_STEPS = 40;
const MAX_THOUGHT_LENGTH = 600;

export async function runProjectAgent(
  message: string,
  context: AgentContext,
): Promise<AgentTurn> {
  const mutations: ProjectGraphMutation[] = [];
  const steps: AgentStep[] = [];
  const client = copilotClient();
  let session: CopilotSession | undefined;

  const mcpServers = context.mcpServers ?? {};
  const usesMcp = Object.keys(mcpServers).length > 0;

  try {
    session = await client.createSession({
      // A fresh session per turn. Runtime sessions expire on their own schedule,
      // while our transcript lives in Postgres, so replaying the history we
      // already have is the only version that stays correct.
      sessionId: `terrablox-${context.userId}-${context.projectId}-${Date.now()}`,
      model: context.model || COPILOT_MODEL,
      gitHubToken: context.githubToken,
      tools: buildTools(context, mutations, steps),
      ...(usesMcp ? { mcpServers } : {}),
      // Omitted rather than defaulted: a model that does not support the
      // setting rejects the session, so "leave it alone" has to mean absent.
      ...(context.reasoningEffort
        ? { reasoningEffort: context.reasoningEffort }
        : {}),
      // The user's stated goal is to work in the UI instead of the code, which
      // only holds if they can still see why the agent did what it did. Models
      // without reasoning summaries ignore this and simply emit no such events.
      reasoningSummary: "concise",
      onEvent: (event) => {
        if (event.type !== "assistant.reasoning") return;
        const text = event.data.content?.trim();
        if (text) pushStep(steps, { kind: "thought", text });
      },
      // Without this the runtime raises a prompt and waits for a human who is
      // not there, and the model reports the call back as "permission denied".
      // The turn runs headless, so the decision has to be made here. What may
      // ask at all is already fenced in by `availableTools` below.
      onPermissionRequest: (request) => {
        pushStep(steps, {
          kind: "tool",
          tool: request.kind,
          summary: "Allowed for this turn",
          ok: true,
        });
        return { kind: "approve-once" };
      },
      // Belt and braces next to the client's "empty" mode: even if the runtime
      // gains new built-ins, this session only ever sees ours. `mcp:*` is added
      // only for users who enabled a server, so the default stays as tight as it
      // was before the feature existed.
      availableTools: usesMcp ? ["custom:*", "mcp:*"] : ["custom:*"],
      // One runtime serves every user, and its embedding cache is shared, so a
      // lookup could surface another tenant's project text. We supply the whole
      // graph in the prompt anyway, so there is nothing to retrieve.
      skipEmbeddingRetrieval: true,
      systemMessage: { content: systemPrompt(context) },
    });

    const response = await session.sendAndWait({ prompt: message });

    return {
      reply:
        response?.data.content?.trim() ||
        "I could not put together an answer for that.",
      mutations,
      steps,
    };
  } catch (error) {
    discardCopilotClient(error);
    throw new Error(describeCopilotError(error));
  } finally {
    // Drops the conversation on the runtime too; keeping it would leave one
    // user's project context sitting on a shared server for no benefit.
    if (session) {
      await client.deleteSession(session.sessionId).catch(() => {});
    }
  }
}

/**
 * What the model is allowed to do.
 *
 * The handlers queue mutations instead of applying them. The caller commits
 * them together after the turn, so a model that changes its mind halfway
 * through does not leave a trail of half-finished commits in the repository.
 * Validation still happens here, against the graph already in memory, so the
 * model gets told about a typo in the same turn rather than after a commit.
 */
function buildTools(
  context: AgentContext,
  sink: ProjectGraphMutation[],
  steps: AgentStep[],
) {
  const disabled = new Set(context.disabledTools ?? []);
  const hasNode = (name: string) =>
    context.graph.nodes.some((node) => node.id === name);

  const queue = (tool: string, mutation: ProjectGraphMutation) => {
    sink.push(mutation);
    pushStep(steps, {
      kind: "tool",
      tool,
      summary: describeMutation(mutation),
      ok: true,
    });
    return { queued: true, pending: sink.length };
  };

  const refuse = (tool: string, error: string) => {
    pushStep(steps, { kind: "tool", tool, summary: error, ok: false });
    return { error };
  };

  return [
    defineTool<{ moduleId: string; name?: string }>("add_module", {
      ...spec("add_module"),
      handler: async ({ moduleId, name }) => {
        if (!context.library.some((mod) => mod.id === moduleId)) {
          return refuse(
            "add_module",
            `No module "${moduleId}" in the library. Available: ${context.library.map((mod) => mod.id).join(", ") || "none"}.`,
          );
        }
        return queue("add_module", { action: "add-module", moduleId, name });
      },
    }),
    defineTool<{ name: string }>("remove_module", {
      ...spec("remove_module"),
      handler: async ({ name }) =>
        hasNode(name)
          ? queue("remove_module", { action: "remove-module", name })
          : refuse("remove_module", unknownModule(name, context)),
    }),
    defineTool<{
      source: string;
      sourceOutput: string;
      target: string;
      targetInput: string;
    }>("connect", {
      ...spec("connect"),
      handler: async (args) => {
        for (const side of [args.source, args.target]) {
          if (!hasNode(side)) {
            return refuse("connect", unknownModule(side, context));
          }
        }
        return queue("connect", { action: "connect", ...args });
      },
    }),
    defineTool<{ target: string; targetInput: string }>("disconnect", {
      ...spec("disconnect"),
      handler: async ({ target, targetInput }) =>
        hasNode(target)
          ? queue("disconnect", { action: "disconnect", target, targetInput })
          : refuse("disconnect", unknownModule(target, context)),
    }),
    defineTool<{ name: string; newName: string }>("rename_module", {
      ...spec("rename_module"),
      handler: async ({ name, newName }) =>
        hasNode(name)
          ? queue("rename_module", { action: "rename-module", name, newName })
          : refuse("rename_module", unknownModule(name, context)),
    }),
    // Withheld rather than refused at call time: a tool the model cannot see is
    // one it will not promise the user and then fail to deliver.
  ].filter((tool) => !disabled.has(tool.name));
}

/** Appends a step, dropping the overflow rather than the earliest context. */
function pushStep(steps: AgentStep[], step: AgentStep): void {
  if (steps.length >= MAX_STEPS) return;

  steps.push(
    step.kind === "thought" && step.text.length > MAX_THOUGHT_LENGTH
      ? { kind: "thought", text: `${step.text.slice(0, MAX_THOUGHT_LENGTH)}…` }
      : step,
  );
}

/** The queued edit in the words the canvas uses, not the tool's argument names. */
function describeMutation(mutation: ProjectGraphMutation): string {
  switch (mutation.action) {
    case "add-module":
      return `Add ${mutation.name ?? mutation.moduleId} from the library`;
    case "remove-module":
      return `Remove ${mutation.name}`;
    case "connect":
      return `Wire ${mutation.target}.${mutation.targetInput} to ${mutation.source}.${mutation.sourceOutput}`;
    case "disconnect":
      return `Clear ${mutation.target}.${mutation.targetInput}`;
    case "rename-module":
      return `Rename ${mutation.name} to ${mutation.newName}`;
    default:
      return mutation.action;
  }
}

/** The description and JSON schema declared once in PROJECT_AGENT_TOOLS. */
function spec(name: (typeof PROJECT_AGENT_TOOLS)[number]["name"]) {
  const tool = PROJECT_AGENT_TOOLS.find((entry) => entry.name === name);
  if (!tool) throw new Error(`No tool definition for ${name}.`);
  return {
    description: tool.description,
    parameters: tool.parameters,
    // A prompt here would wait for a human who is not in the loop: these tools
    // only queue a mutation, and the commit afterwards is ours to authorise.
    skipPermission: true,
  };
}

function unknownModule(name: string, context: AgentContext): string {
  const known = context.graph.nodes.map((node) => node.id).join(", ");
  return `There is no module block called "${name}". On the canvas: ${known || "nothing yet"}.`;
}

/**
 * The project, written out for the model.
 *
 * The graph is small and already loaded, so handing it over up front is
 * cheaper and more reliable than giving the model read tools and hoping it
 * asks the right questions.
 */
function systemPrompt(context: AgentContext): string {
  const { graph } = context;

  const modules = graph.nodes.length
    ? graph.nodes
        .map(
          (node) =>
            `- ${node.id}${node.moduleName ? ` (module ${node.moduleName}${node.version ? `@${node.version}` : ""})` : ""}`,
        )
        .join("\n")
    : "(none)";

  const wiring = graph.edges.length
    ? graph.edges
        .flatMap((edge) =>
          edge.links.map(
            (link) =>
              `- ${edge.target}.${link.targetInput} = ${edge.source}.${link.sourceOutput ?? "?"}`,
          ),
        )
        .join("\n")
    : "(nothing wired up)";

  const gaps = graph.gaps.length
    ? graph.gaps
        .map(
          (gap) =>
            `- ${gap.node}.${gap.input} is unset${
              gap.wirable.length
                ? `; could come from ${gap.wirable.map((w) => `${w.node}.${w.output}`).join(" or ")}`
                : ""
            }`,
        )
        .join("\n")
    : "(none)";

  const library = context.library.length
    ? context.library
        .map(
          (mod) =>
            `- ${mod.id}: ${mod.name}${mod.versionTag ? ` @${mod.versionTag}` : ""}`,
        )
        .join("\n")
    : "(empty)";

  // Last few turns only. The graph above already reflects everything earlier
  // turns changed, so older messages add tokens without adding facts.
  const history = context.history
    .slice(-8)
    .map((entry) => `${entry.role}: ${entry.content}`)
    .join("\n");

  return [
    `You are the TerraBlox agent for the project "${context.projectName}", backed by ${context.repoFullName} on branch ${context.branch}.`,
    "",
    "You edit Terraform root configurations only through the tools you were given. Never invent HCL in your reply as a substitute for calling a tool.",
    "Every tool call is committed to the repository after your turn, so ask before doing anything destructive such as removing a module.",
    "Keep replies short and concrete. Say what you changed, not how the tools work.",
    // Named explicitly, because otherwise the model reads a missing tool as its
    // own failure and apologises instead of telling the user where the switch is.
    ...disabledToolNotice(context.disabledTools),
    "",
    `## Modules on the canvas (${graph.nodes.length})`,
    modules,
    "",
    "## Wiring",
    wiring,
    "",
    "## Unset required inputs",
    gaps,
    "",
    "## Module library available to add",
    library,
    "",
    `Root-level resource/data blocks: ${graph.resourceCount}. Files: ${graph.files.join(", ") || "none"}.`,
    // Skills and the user's own instructions come last, after the facts, so
    // they read as standing preferences rather than as part of the graph. The
    // operating rules at the top still win: this text is the user's, but the
    // guarantee that edits go through tools is ours.
    ...skillSections(context.skills),
    ...(context.instructions?.trim()
      ? [
          "",
          "## The user's own instructions",
          "Follow these unless they conflict with the rules above.",
          context.instructions.trim(),
        ]
      : []),
    ...(history ? ["", "## Conversation so far", history] : []),
  ].join("\n");
}

/** Tells the model a capability was withheld by the user, not lost to a bug. */
function disabledToolNotice(disabled: string[] | undefined): string[] {
  const names = (disabled ?? []).filter(isKnownTool);
  if (!names.length) return [];

  return [
    `The user has switched off these tools for this project: ${names.join(", ")}. You do not have them. If asked for one, say it is disabled in the agent settings and offer the closest thing you can still do.`,
  ];
}

function skillSections(skills: AgentSkill[] | undefined): string[] {
  if (!skills?.length) return [];

  return ["", "## Skills the user enabled", ...skills.map((s) => s.content)];
}
