import "server-only";

import {
  type CopilotSession,
  defineTool,
  type MCPServerConfig,
} from "@github/copilot-sdk";

import {
  GithubRequestError,
  listRepoTree,
  readRepoFile,
} from "@/lib/github/repo-files";
import { isValidLocalName } from "@/lib/projects/locals";
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
import {
  KNOWLEDGE_APP_REPO,
  KNOWLEDGE_MODULE_LIBRARY,
  KNOWLEDGE_PROJECT_REPO,
  knowledgeEnabled,
} from "./knowledge";
import {
  AGENT_APP_REPO_FILE_CHARS,
  AGENT_APP_REPO_IGNORED_DIRS,
  AGENT_APP_REPO_TREE_LIMIT,
  AGENT_HISTORY_BUDGET_CHARS,
  AGENT_MAX_APP_REPO_READS,
  AGENT_MAX_STEPS,
  AGENT_MAX_TOOL_CALLS,
  DEFAULT_OPERATING_RULES,
  DEFAULT_TURN_TIMEOUT_SECONDS,
  renderOperatingRule,
} from "./runtime-options";
import type { ReasoningEffortValue } from "./settings-service";
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
  /**
   * The application this infrastructure is for, when the project names one.
   *
   * Not prompt text like the rest of the context: the repository is somebody's
   * whole codebase and cannot be inlined, so this is a pointer the read tools
   * work from. Null — or a project with no link — means those tools are never
   * registered, and the prompt says the agent has to ask instead.
   */
  appRepo?: { fullName: string; branch: string } | null;
  /** What this user told the agent about how they work. */
  instructions?: string;
  /**
   * Knowledge sources withheld from this turn.
   *
   * The caller has already emptied the corresponding fields — `library` is `[]`
   * when the library is withheld, and `graph` carries no nodes when the
   * repository is. This list exists so the prompt can *say* the data is absent
   * by choice; without it the model reads an empty project as a new one and
   * cheerfully starts building on top of whatever is really there.
   */
  disabledKnowledge?: string[];
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
  /**
   * The operating rules to put at the top of the prompt, already rendered.
   *
   * Passed in rather than read here because this module has no database access,
   * and because a turn must be reproducible from its context alone. Omitted falls
   * back to the code defaults, which is what keeps the agent working when the
   * curation table is unreachable.
   */
  operatingRules?: string[];
  /**
   * Model-facing tool descriptions, by tool name, overriding the catalogue.
   *
   * Only the description: the name and the JSON schema stay in code, because a
   * renamed tool or a broken schema fails in ways nobody sees until a turn
   * misbehaves.
   */
  toolDescriptions?: Record<string, string>;
  /**
   * Whether the agent may delete things.
   *
   * The prompt used to say "ask before doing anything destructive", which was a
   * request the model could decline and nothing more — permission prompts are
   * auto-approved here, because the turn runs headless. Off, the two destructive
   * operations are simply not registered, so this is a capability the agent does
   * not have rather than a rule it is trusted to follow.
   */
  allowDestructive?: boolean;
  /** How long this turn may run, in seconds. Null → default (300s). */
  turnTimeout?: number | null;
  /**
   * Called whenever the trail grows, with the whole trail so far.
   *
   * A turn that builds a stack can run for minutes, and until it returned the UI
   * had nothing to show but a spinner — indistinguishable from a hang. The caller
   * decides where to put the progress; this only reports it. Errors thrown here
   * would kill a working turn, so the caller must swallow its own.
   */
  onStep?: (steps: AgentStep[]) => void;
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
/**
 * How long the agent may think per turn.
 *
 * `sendAndWait` defaults to 60 000 ms, which is too short for multi-step tasks
 * like "build me a whole infrastructure". Each tool call is a round trip to the
 * runtime, and a complex task easily chains 10–20 of them.
 *
 * 5 minutes is generous but finite: a turn that stalls beyond that is not
 * thinking harder, it has hit an issue the user needs to hear about.
 *
 * Overridable per user / per project via agent settings (`turnTimeout` in
 * seconds, 30–1800).
 */
const DEFAULT_TURN_TIMEOUT_MS = DEFAULT_TURN_TIMEOUT_SECONDS * 1000;

const MAX_STEPS = AGENT_MAX_STEPS;

/**
 * The operations that delete something, and every reference to it.
 *
 * Named here rather than flagged in the catalogue because this is the agent's
 * question, not the catalogue's: the same operations remain available on the
 * canvas, where a person is looking at what they are removing.
 */
const DESTRUCTIVE_TOOLS = ["remove_module", "remove_local"] as const;
const MAX_THOUGHT_LENGTH = 600;

export async function runProjectAgent(
  message: string,
  context: AgentContext,
): Promise<AgentTurn> {
  const mutations: ProjectGraphMutation[] = [];
  const steps: AgentStep[] = [];
  /**
   * Records a step and tells the caller, so progress is visible while the turn
   * is still running rather than only in the finished message.
   */
  const record = (step: AgentStep) => {
    pushStep(steps, step);
    context.onStep?.(steps);
  };
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
      tools: buildTools(context, mutations, record),
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
        if (text) record({ kind: "thought", text });
      },
      // Without this the runtime raises a prompt and waits for a human who is
      // not there, and the model reports the call back as "permission denied".
      // The turn runs headless, so the decision has to be made here. What may
      // ask at all is already fenced in by `availableTools` below.
      onPermissionRequest: (request) => {
        record({
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

    const timeoutMs = context.turnTimeout
      ? context.turnTimeout * 1000
      : DEFAULT_TURN_TIMEOUT_MS;

    const response = await session.sendAndWait({ prompt: message }, timeoutMs);

    return {
      reply:
        response?.data.content?.trim() ||
        "I could not put together an answer for that.",
      mutations,
      steps,
    };
  } catch (error) {
    // `sendAndWait` only stops *waiting* — the SDK says so plainly, and its
    // implementation races the wait against a timer. Without this the runtime
    // would carry on thinking for a turn nobody is listening to any more, on the
    // user's own Copilot quota. `abort` is the SDK's cancellation for exactly
    // that, and is harmless when nothing is in flight.
    await session?.abort().catch(() => {});

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
  record: (step: AgentStep) => void,
) {
  const disabled = new Set(context.disabledTools ?? []);

  // Withheld rather than refused at call time, for the same reason the library
  // withholds `add_module`: the model is told in the prompt which operations are
  // unavailable, so it says what it cannot do instead of promising a deletion and
  // then failing. Deleting a module rewrites every reference to it, which is the
  // one change on this canvas that a user cannot reconstruct by looking at it.
  if (!context.allowDestructive) {
    for (const tool of DESTRUCTIVE_TOOLS) disabled.add(tool);
  }

  // Withheld together with the library itself. `add_module` takes a library id
  // and nothing else, so without a library it can only ever refuse — and a tool
  // that can only refuse is worse than an absent one, because the model will
  // promise the user a module first and discover the problem afterwards.
  if (!knowledgeEnabled(context.disabledKnowledge, KNOWLEDGE_MODULE_LIBRARY)) {
    disabled.add("add_module");
  }

  // Same reasoning once more: with no repository linked there is nothing for
  // these two to read, so they are absent rather than present-and-failing. A
  // project with no application is the common case, not an error.
  const appRepo =
    context.appRepo &&
    knowledgeEnabled(context.disabledKnowledge, KNOWLEDGE_APP_REPO)
      ? context.appRepo
      : null;

  if (!appRepo) {
    disabled.add("list_app_files");
    disabled.add("read_app_file");
  }

  // Kind-aware since locals joined the graph: a module and a local may share a
  // name, and "is there a node called vpc" stopped being the right question.
  // Both checks include already-queued mutations, so a second `add_local` in
  // the same turn sees the first rather than queuing a duplicate that fails on
  // commit.
  const hasNode = (name: string) =>
    context.graph.nodes.some(
      (node) => node.id === name && node.kind === "module",
    ) || sink.some((m) => m.action === "add-module" && m.name === name);

  const hasLocal = (name: string) =>
    context.graph.nodes.some(
      (node) => node.id === name && node.kind === "local",
    ) || sink.some((m) => m.action === "add-local" && m.name === name);

  /** Bound to this turn's curated descriptions; the schema stays from code. */
  const spec = (name: (typeof PROJECT_AGENT_TOOLS)[number]["name"]) =>
    toolSpec(name, context.toolDescriptions);

  const refuse = (tool: string, error: string) => {
    record({ kind: "tool", tool, summary: error, ok: false });
    return { error };
  };

  /**
   * Charges one read against the turn's own budget, separate from `queue()`.
   *
   * Reads commit nothing, so they must not spend the operation budget — a turn
   * that studied an application closely would otherwise have nothing left to
   * build with. They still get a ceiling, because each one is a GitHub request on
   * the user's rate limit. Returns a refusal to hand straight back, or nothing
   * when there was budget left.
   */
  let reads = 0;
  const spendRead = (tool: string) => {
    if (reads >= AGENT_MAX_APP_REPO_READS) {
      return refuse(
        tool,
        `Reading budget spent: a single turn may read the application repository at most ${AGENT_MAX_APP_REPO_READS} times. Work with what you have already seen, and say what you were still looking for.`,
      );
    }
    reads += 1;
    return null;
  };

  const queue = (tool: string, mutation: ProjectGraphMutation) => {
    // The budget is enforced here rather than counted for the record, because
    // every queued operation becomes a commit once the turn ends. Refusing with
    // a reason lets the model wind up and report; dropping the call silently
    // would leave it convinced the edit had been made.
    if (sink.length >= AGENT_MAX_TOOL_CALLS) {
      return refuse(
        tool,
        `Operation budget spent: a single turn may queue at most ${AGENT_MAX_TOOL_CALLS} changes. Tell the user what you have already queued and ask them to continue in a new message.`,
      );
    }

    sink.push(mutation);
    record({
      kind: "tool",
      tool,
      summary: describeMutation(mutation),
      ok: true,
    });
    return { queued: true, pending: sink.length };
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
      handler: async ({ target, targetInput }) => {
        if (!hasNode(target)) {
          return refuse("disconnect", unknownModule(target, context));
        }
        // Sent to the variable tool rather than done here, so that switching one
        // of the two off is a real restriction. Both end in the same mutation, so
        // without this check the module tool would quietly cover both.
        if (readsLocal(context, target, targetInput)) {
          return refuse(
            "disconnect",
            `${target}.${targetInput} is fed by a variable, not by a module. Use disconnect_local.`,
          );
        }
        return queue("disconnect", {
          action: "disconnect",
          target,
          targetInput,
        });
      },
    }),
    defineTool<{
      name: string;
      newName?: string;
      arguments?: Array<{ input: string; value: string }>;
    }>("edit_module", {
      ...spec("edit_module"),
      handler: async ({ name, newName, arguments: args }) => {
        if (!hasNode(name)) {
          return refuse("edit_module", unknownModule(name, context));
        }

        const settings = (args ?? []).filter(
          (entry) => entry?.input && typeof entry.value === "string",
        );

        if (!newName && settings.length === 0) {
          return refuse(
            "edit_module",
            "Nothing to change. Pass `newName`, `arguments`, or both.",
          );
        }

        // Arguments first: after a rename they would have to name the module by
        // its new label, and queueing them in this order means the model does not
        // have to reason about that.
        for (const entry of settings) {
          queue("edit_module", {
            action: "set-argument",
            name,
            input: entry.input,
            value: entry.value,
          });
        }

        if (newName) {
          return queue("edit_module", {
            action: "rename-module",
            name,
            newName,
          });
        }

        return { queued: true, pending: sink.length };
      },
    }),
    defineTool<{
      name: string;
      value: string;
      connectTo?: { target: string; targetInput: string };
    }>("add_local", {
      ...spec("add_local"),
      handler: async ({ name, value, connectTo }) => {
        if (!isValidLocalName(name)) {
          return refuse(
            "add_local",
            `"${name}" is not a valid local name. Use letters, digits and underscores, starting with a letter.`,
          );
        }
        if (hasLocal(name)) {
          return refuse(
            "add_local",
            `A value called "${name}" already exists.`,
          );
        }
        if (connectTo && !hasNode(connectTo.target)) {
          return refuse("add_local", unknownModule(connectTo.target, context));
        }

        return queue("add_local", {
          action: "add-local",
          name,
          value,
          ...(connectTo ? { connectTo } : {}),
        });
      },
    }),
    defineTool<{ name: string; newName?: string; value?: string }>(
      "edit_local",
      {
        ...spec("edit_local"),
        handler: async ({ name, newName, value }) => {
          if (!hasLocal(name)) {
            return refuse("edit_local", unknownLocal(name, context));
          }
          if (newName !== undefined && !isValidLocalName(newName)) {
            return refuse(
              "edit_local",
              `"${newName}" is not a valid variable name. Use letters, digits and underscores, starting with a letter.`,
            );
          }
          if (newName === undefined && value === undefined) {
            return refuse(
              "edit_local",
              "Nothing to change. Pass `newName`, `value`, or both.",
            );
          }

          // The value first, for the same reason as `edit_module`: afterwards the
          // variable answers to a different name.
          if (value !== undefined) {
            queue("edit_local", { action: "set-local", name, value });
          }

          if (newName !== undefined) {
            return queue("edit_local", {
              action: "rename-local",
              name,
              newName,
            });
          }

          return { queued: true, pending: sink.length };
        },
      },
    ),
    defineTool<{ name: string }>("remove_local", {
      ...spec("remove_local"),
      handler: async ({ name }) =>
        hasLocal(name)
          ? queue("remove_local", { action: "remove-local", name })
          : refuse("remove_local", unknownLocal(name, context)),
    }),
    defineTool<{ local: string; target: string; targetInput: string }>(
      "connect_local",
      {
        ...spec("connect_local"),
        handler: async ({ local, target, targetInput }) => {
          if (!hasLocal(local)) {
            return refuse("connect_local", unknownLocal(local, context));
          }
          if (!hasNode(target)) {
            return refuse("connect_local", unknownModule(target, context));
          }
          return queue("connect_local", {
            action: "connect-local",
            local,
            target,
            targetInput,
          });
        },
      },
    ),
    defineTool<{ target: string; targetInput: string }>("disconnect_local", {
      ...spec("disconnect_local"),
      handler: async ({ target, targetInput }) => {
        if (!hasNode(target)) {
          return refuse("disconnect_local", unknownModule(target, context));
        }
        if (!readsLocal(context, target, targetInput)) {
          return refuse(
            "disconnect_local",
            `${target}.${targetInput} does not read a variable. Use disconnect to clear an input fed by another module.`,
          );
        }
        // The same mutation as `disconnect`: clearing an argument is one edit
        // whatever fed it. The two tools differ in what they will clear, not in
        // what they do.
        return queue("disconnect_local", {
          action: "disconnect",
          target,
          targetInput,
        });
      },
    }),
    defineTool<{ path?: string }>("list_app_files", {
      ...spec("list_app_files"),
      handler: async ({ path }) => {
        if (!appRepo) return refuse("list_app_files", NO_APP_REPO);

        const spend = spendRead("list_app_files");
        if (spend) return spend;

        try {
          const tree = await listRepoTree(context.githubToken, {
            repoFullName: appRepo.fullName,
            ref: appRepo.branch,
          });

          const prefix = normaliseAppPath(path);
          const files = tree.entries
            .filter((entry) => entry.type === "blob")
            .map((entry) => entry.path)
            .filter((entry) => !prefix || entry.startsWith(`${prefix}/`))
            .filter((entry) => !isIgnoredAppPath(entry))
            .sort();

          const shown = files.slice(0, AGENT_APP_REPO_TREE_LIMIT);
          const omitted = files.length - shown.length;

          record({
            kind: "tool",
            tool: "list_app_files",
            summary: `Listed ${shown.length} file${shown.length === 1 ? "" : "s"} in ${appRepo.fullName}${prefix ? `/${prefix}` : ""}`,
            ok: true,
          });

          return {
            repository: appRepo.fullName,
            ref: appRepo.branch,
            ...(prefix ? { path: prefix } : {}),
            files: shown,
            ...(omitted > 0
              ? {
                  truncated: `${omitted} more file(s) not shown. Pass \`path\` to list one directory at a time.`,
                }
              : {}),
          };
        } catch (error) {
          return refuse("list_app_files", describeAppRepoError(error, appRepo));
        }
      },
    }),
    defineTool<{ path: string }>("read_app_file", {
      ...spec("read_app_file"),
      handler: async ({ path }) => {
        if (!appRepo) return refuse("read_app_file", NO_APP_REPO);

        const wanted = normaliseAppPath(path);
        if (!wanted) {
          return refuse("read_app_file", "Pass the path of a file to read.");
        }

        const spend = spendRead("read_app_file");
        if (spend) return spend;

        try {
          const file = await readRepoFile(context.githubToken, {
            repoFullName: appRepo.fullName,
            path: wanted,
            ref: appRepo.branch,
          });

          if (!file) {
            return refuse(
              "read_app_file",
              `No file at ${wanted} in ${appRepo.fullName}. Use list_app_files to see what is there.`,
            );
          }

          const truncated = file.content.length > AGENT_APP_REPO_FILE_CHARS;

          record({
            kind: "tool",
            tool: "read_app_file",
            summary: `Read ${wanted} from ${appRepo.fullName}`,
            ok: true,
          });

          return {
            repository: appRepo.fullName,
            path: wanted,
            content: truncated
              ? file.content.slice(0, AGENT_APP_REPO_FILE_CHARS)
              : file.content,
            ...(truncated
              ? {
                  truncated: `Only the first ${AGENT_APP_REPO_FILE_CHARS} characters are shown.`,
                }
              : {}),
          };
        } catch (error) {
          return refuse("read_app_file", describeAppRepoError(error, appRepo));
        }
      },
    }),
    // Withheld rather than refused at call time: a tool the model cannot see is
    // one it will not promise the user and then fail to deliver.
  ].filter((tool) => !disabled.has(tool.name));
}

/** Said the same way wherever a read tool runs without a repository behind it. */
const NO_APP_REPO =
  "No application repository is linked to this project. Ask the user to link one in the agent settings, or ask them about the application directly.";

/**
 * Strips a path down to something safe to put in a GitHub URL.
 *
 * The model supplies these, and a `..` segment in one would address a directory
 * outside the repository the user actually linked. Dropping the segments rather
 * than refusing keeps a harmless leading `./` from costing a turn a tool call.
 */
function normaliseAppPath(path: string | undefined): string {
  return (path ?? "")
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");
}

/** Whether any segment of a path is a dependency or build directory. */
function isIgnoredAppPath(path: string): boolean {
  const segments = path.split("/");
  // The last segment is the file itself, which is never a directory name.
  return segments
    .slice(0, -1)
    .some((segment) => AGENT_APP_REPO_IGNORED_DIRS.includes(segment));
}

/**
 * A GitHub failure in words the model can act on.
 *
 * The raw message carries a status code and a JSON body, which a model tends to
 * either repeat at the user or read as its own mistake and retry. The two cases
 * worth distinguishing are both about access rather than about the call.
 */
function describeAppRepoError(
  error: unknown,
  appRepo: { fullName: string; branch: string },
): string {
  if (error instanceof GithubRequestError) {
    if (error.status === 404) {
      return `Cannot reach ${appRepo.fullName} at ${appRepo.branch}. Either the branch does not exist or the linked account can no longer see the repository. Tell the user; do not retry.`;
    }
    if (error.status === 401 || error.status === 403) {
      return `Not allowed to read ${appRepo.fullName}. Tell the user their GitHub access to the linked application repository needs checking; do not retry.`;
    }
  }

  return `Could not read ${appRepo.fullName}: ${error instanceof Error ? error.message : "unknown error"}.`;
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
    case "set-argument":
      return `Set ${mutation.name}.${mutation.input}`;
    case "add-local":
      return mutation.connectTo
        ? `Add variable ${mutation.name} and wire it to ${mutation.connectTo.target}.${mutation.connectTo.targetInput}`
        : `Add variable ${mutation.name}`;
    case "set-local":
      return `Set variable ${mutation.name}`;
    case "rename-local":
      return `Rename variable ${mutation.name} to ${mutation.newName}`;
    case "remove-local":
      return `Remove variable ${mutation.name}`;
    case "connect-local":
      return `Wire ${mutation.target}.${mutation.targetInput} to local.${mutation.local}`;
    default:
      return mutation.action;
  }
}

/**
 * Whether a module input is currently fed by a variable.
 *
 * Read from the graph the turn started with, which is also what the model was
 * shown, so a refusal it gets back matches what it was told.
 */
function readsLocal(
  context: AgentContext,
  target: string,
  targetInput: string,
): boolean {
  return context.graph.edges.some(
    (edge) =>
      edge.target === target &&
      edge.sourceKind === "local" &&
      edge.links.some((link) => link.targetInput === targetInput),
  );
}

function unknownLocal(name: string, context: AgentContext): string {
  const known = context.graph.nodes
    .filter((node) => node.kind === "local")
    .map((node) => node.id)
    .join(", ");

  return `No value "${name}" in this project. Available: ${known || "none"}.`;
}

/**
 * The description and JSON schema declared once in PROJECT_AGENT_TOOLS.
 *
 * The description may be overridden from the admin panel, the schema may not: a
 * reworded description is a prompt change the model copes with, while a changed
 * schema is a tool that stops matching its handler and fails in a way nobody sees
 * until a turn misbehaves.
 */
function toolSpec(
  name: (typeof PROJECT_AGENT_TOOLS)[number]["name"],
  descriptions: Record<string, string> | undefined,
) {
  const tool = PROJECT_AGENT_TOOLS.find((entry) => entry.name === name);
  if (!tool) throw new Error(`No tool definition for ${name}.`);
  return {
    description: descriptions?.[name] ?? tool.description,
    parameters: tool.parameters,
    // A prompt here would wait for a human who is not in the loop: these tools
    // only queue a mutation, and the commit afterwards is ours to authorise.
    skipPermission: true,
  };
}

function unknownModule(name: string, context: AgentContext): string {
  const known = context.graph.nodes
    .filter((node) => node.kind === "module")
    .map((node) => node.id)
    .join(", ");
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

  const modules = moduleNodes.length
    ? moduleNodes
        .map(
          (node) =>
            `- ${node.id}${node.moduleName ? ` (module ${node.moduleName}${node.version ? `@${node.version}` : ""})` : ""}`,
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
  const memory = recallConversation(context.history);

  return [
    `You are the TerraBlox agent for the project "${context.projectName}", backed by ${context.repoFullName} on branch ${context.branch}.`,
    "",
    // Editable in the admin panel, defaults in `harness-curation`. Rendered
    // there, so a rule quoting the operation budget cannot quote a wrong one.
    ...(context.operatingRules ??
      DEFAULT_OPERATING_RULES.map(renderOperatingRule)),
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
          "## Unset required inputs",
          gaps,
          "",
          `Root-level resource/data blocks: ${graph.resourceCount}. Files: ${graph.files.join(", ") || "none"}.`,
        ]
      : []),
    ...(hasLibrary ? ["", "## Module library available to add", library] : []),
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
          // The two reasons for having no application read differently to a user:
          // one is a project that was never linked, the other is a deliberate
          // restriction. Saying "not linked" to someone who switched it off
          // themselves sends them to the wrong screen.
          context.appRepo
            ? `This project is linked to ${context.appRepo.fullName}, but the user has withheld it from you: you cannot read the application's code in this turn. Say that application repository access is switched off in the agent settings, and ask them about the application instead of assuming.`
            : "No application repository is linked to this project, so you cannot see the application's code. Ask the user what runs on this infrastructure — runtime, ports, data stores, how it is deployed — rather than assuming, and mention that linking a repository in the agent settings would let you read it yourself.",
        ]),
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

/**
 * The project's conversation, newest-first until the budget runs out.
 *
 * One memory per project, holding as much of its own history as can be carried.
 * Filling backwards is what makes the limit bite in the right place: the turns
 * that matter to the question being asked are the recent ones, and it is the
 * opening small talk that gets dropped.
 */
function recallConversation(
  history: Array<{ role: string; content: string }>,
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
    if (used + line.length > AGENT_HISTORY_BUDGET_CHARS && taken > 0) break;

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

/** Tells the model a capability was withheld by the user, not lost to a bug. */
function disabledToolNotice(disabled: string[] | undefined): string[] {
  const names = (disabled ?? []).filter(isKnownTool);
  if (!names.length) return [];

  return [
    `The user has switched off these tools for this project: ${names.join(", ")}. You do not have them. If asked for one, say it is disabled in the agent settings and offer the closest thing you can still do.`,
  ];
}
