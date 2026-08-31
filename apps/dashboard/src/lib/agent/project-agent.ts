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
import { coerceHclValue } from "@/lib/projects/wiring";
import { checkValueAgainstType } from "@/lib/terraform/type-check";

import {
  COPILOT_MODEL,
  copilotClient,
  describeCopilotError,
  discardCopilotClient,
} from "./copilot";
import {
  closestName,
  GraphProjection,
  type ProblemSeverity,
} from "./graph-projection";
import {
  KNOWLEDGE_APP_REPO,
  KNOWLEDGE_MODULE_LIBRARY,
  KNOWLEDGE_PROJECT_REPO,
  knowledgeEnabled,
} from "./knowledge";
import {
  type AgentLibraryModule,
  DESCRIBE_PORT_LIMIT,
  renderPort,
  summariseCost,
  summariseLibraryModule,
} from "./library-view";
import {
  AGENT_APP_REPO_FILE_CHARS,
  AGENT_APP_REPO_IGNORED_DIRS,
  AGENT_APP_REPO_TREE_LIMIT,
  AGENT_HISTORY_BUDGET_CHARS,
  AGENT_MAX_APP_REPO_READS,
  AGENT_MAX_MCP_CALLS,
  AGENT_MAX_STEPS,
  AGENT_MAX_THOUGHTS,
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

/**
 * The result of the last pipeline run on the project's branch.
 *
 * The closest thing to `terraform validate` a turn can see. The real validation
 * runs in the user's own CI, minutes after a commit and outside any turn, so it
 * cannot be waited for — but its verdict on the *previous* turn's work is a fact
 * worth carrying into this one. A model told its last commit failed validation
 * fixes it; a model told nothing builds on top of it.
 */
/**
 * The linked application repository, ready to read.
 *
 * The credential travels with the repository rather than being looked up where it
 * is used, and that is the point: the token that was proven to read this
 * repository is the one the reads are made with. Carrying it beside the name makes
 * it impossible to have a repository without the access to read it.
 *
 * `branch` is already resolved: the caller turns "no pinned ref" into the
 * repository's current default before the turn starts.
 */
export interface AgentAppRepo {
  fullName: string;
  branch: string;
  /** The provider credential the repository was chosen with. */
  token: string;
}

export interface AgentPipelineCheck {
  name: string;
  /** `queued`, `in_progress`, `completed`. */
  status: string;
  /** `success`, `failure`, `cancelled`, … or null while it is still running. */
  conclusion: string | null;
  htmlUrl: string;
  createdAt: string;
}

export interface AgentContext {
  projectName: string;
  repoFullName: string;
  branch: string;
  graph: ProjectGraph;
  /**
   * The modules this project may place, with their ports.
   *
   * The ports are here for validation and for `describe_module`, not for the
   * prompt: the prompt gets one line per module from
   * {@link summariseLibraryModule}. Handing the model every port of every module
   * would spend most of a turn's context on modules it never touches.
   */
  library: AgentLibraryModule[];
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
  appRepo?: AgentAppRepo | null;
  /**
   * That a link exists, whether or not it can be used this turn.
   *
   * Separate from `appRepo` because "linked" and "readable" are different facts
   * and lead to different sentences. Withheld by the user, unreachable on GitHub,
   * and never linked at all are three situations a person fixes on three
   * different screens, so the prompt has to be able to tell them apart.
   */
  appRepoLink?: { fullName: string } | null;
  /** Why the link above could not be used, when that is the reason it is absent. */
  appRepoProblem?: string | null;
  /**
   * The resource types a set of library modules creates, looked up on demand.
   *
   * A callback rather than data, for the same reason the app repository is a
   * pointer: a module is tens of resource rows, and the library is hundreds of
   * modules. `describe_module` asks about the two or three a turn cares about.
   * Absent means the cost section of an answer is simply left out — this module has
   * no database access of its own and must keep working without one.
   */
  moduleResources?: (
    moduleIds: string[],
  ) => Promise<Record<string, Array<{ kind: string; resourceType: string }>>>;
  /** How the last pipeline run on this branch ended, when it can be read. */
  lastCheck?: AgentPipelineCheck | null;
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
  /** How long this turn may run, in seconds. Null → the default. */
  turnTimeout?: number | null;
  /**
   * The per-turn budgets, or null for the defaults.
   *
   * Passed in rather than read from the constants for the same reason the
   * operating rules are: a turn has to be reproducible from its context alone,
   * and the rules quote the operation budget — a number the prompt states and the
   * code enforces must come from one place or they will eventually disagree.
   */
  maxToolCalls?: number | null;
  maxMcpCalls?: number | null;
  /**
   * Characters of this project's conversation to replay, or null for the default.
   *
   * The agent's whole long-term memory, so it is the caller's to decide: the
   * transcript lives in their database, not here.
   */
  historyBudgetChars?: number | null;
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
 * The default is the ceiling, and the number lives in `runtime-options` so the
 * settings screen and this cannot disagree. Generous on purpose: a turn killed
 * while it was still working leaves nothing behind — no commit, no explanation —
 * which is worse than one that ran long. Lower it per user or per project when a
 * shorter leash is wanted.
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

/**
 * How many modules a plan may add before the user is asked first.
 *
 * "Build me an infrastructure" is a request whose answer is a dozen commits in
 * somebody's repository, and the agent's reading of it is worth checking while it
 * is still a sentence. Below the threshold the plan is recorded and built in the
 * same turn, because stopping to confirm two modules is friction rather than
 * safety.
 *
 * Four rather than one: a working stack is rarely fewer — a network, a database, a
 * service, a load balancer — and a threshold that fires on every real request
 * trains the user to wave it through, which is worse than not having it.
 */
const PLAN_CONFIRM_THRESHOLD = 4;

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

  /**
   * MCP calls made this turn, against their own budget.
   *
   * Counted here rather than in `buildTools` because these tools are not ours:
   * the runtime owns them, and the only point at which our code sits between the
   * model's decision and the request is the permission handler below.
   */
  let mcpCalls = 0;

  /** The budgets in force for this turn: the caller's choice, or the defaults. */
  const maxMcpCalls = context.maxMcpCalls ?? AGENT_MAX_MCP_CALLS;

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
        if (event.type === "assistant.reasoning") {
          const text = event.data.content?.trim();
          if (text) record({ kind: "thought", text });
          return;
        }

        // A server that will not connect is otherwise completely silent: the
        // model is simply never offered its tools, so it answers from what it
        // does have and the user is left believing the connection worked. The
        // wrong URL and the expired token are the two most likely states of a
        // freshly added server, and both arrive here.
        if (event.type === "session.mcp_server_status_changed") {
          const { serverName, status, error } = event.data;
          if (status !== "failed" && status !== "needs-auth") return;

          record({
            kind: "tool",
            tool: `mcp:${serverName}`,
            summary:
              status === "needs-auth"
                ? "The server wants credentials. Check its auth header in Agent Settings."
                : `The server could not be reached${error ? `: ${error}` : "."}`,
            ok: false,
          });
        }
      },
      // Without this the runtime raises a prompt and waits for a human who is
      // not there, and the model reports the call back as "permission denied".
      // The turn runs headless, so the decision has to be made here. What may
      // ask at all is already fenced in by `availableTools` below.
      onPermissionRequest: (request) => {
        // MCP is the one kind that is not ours and not fixed in number, so it is
        // the one kind with a budget and a real record. Our own tools set
        // `skipPermission`, so they never arrive here at all.
        if (request.kind === "mcp") {
          const tool = `${request.serverName}.${request.toolName}`;

          if (mcpCalls >= maxMcpCalls) {
            const refusal = `MCP budget spent: a single turn may call your MCP servers at most ${maxMcpCalls} times. Answer with what you have already learned, and say what you were still looking for.`;

            record({ kind: "tool", tool, summary: refusal, ok: false });
            return { kind: "reject", feedback: refusal };
          }

          mcpCalls += 1;

          record({
            kind: "tool",
            tool,
            // `readOnly` is the server's own annotation rather than anything we
            // verify, so it is reported as the claim it is. Naming it at all is
            // the point: it is the only signal in the trail that distinguishes a
            // lookup from a call that changed something on somebody else's side.
            summary: `${request.toolTitle || request.toolName}${
              request.readOnly
                ? ""
                : " (the server does not call this read-only)"
            }`,
            ok: true,
          });

          return { kind: "approve-once" };
        }

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

  /** This turn's operation budget: the caller's choice, or the default. */
  const maxToolCalls = context.maxToolCalls ?? AGENT_MAX_TOOL_CALLS;

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

  if (!knowledgeEnabled(context.disabledKnowledge, KNOWLEDGE_MODULE_LIBRARY)) {
    disabled.add("describe_module");
  }

  /**
   * The project as this turn's queued edits will leave it.
   *
   * Every check below reads from here rather than from `context.graph`, which is
   * the repository as the turn *started*. That difference is the whole reason this
   * exists: a module added four calls ago is not in the graph, and until now the
   * agent could neither wire it correctly nor be told when it wired it wrongly.
   */
  const projection = new GraphProjection(context.graph, context.library);

  const hasNode = (name: string) => projection.module(name) !== undefined;
  const hasLocal = (name: string) => projection.local(name) !== undefined;

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

  /**
   * The application's file tree, fetched at most once per turn.
   *
   * `listRepoTree` is two requests and returns the *whole* repository recursively,
   * and `list_app_files` filters that list by prefix. So listing the root, then
   * `services/api`, then `services/web` used to fetch the same tree three times —
   * six requests on the user's rate limit for one commit's worth of paths that
   * cannot change mid-turn.
   *
   * The promise is cached rather than its result, so two calls in flight together
   * share one request. A rejection is cached too, on purpose: the second attempt
   * would fail the same way, and spending a request to prove it helps nobody.
   */
  let appTree: Promise<Awaited<ReturnType<typeof listRepoTree>>> | null = null;
  const loadAppTree = (repo: AgentAppRepo) => {
    appTree ??= listRepoTree(repo.token, {
      repoFullName: repo.fullName,
      ref: repo.branch,
    });
    return appTree;
  };

  const queue = (tool: string, mutation: ProjectGraphMutation) => {
    // The budget is enforced here rather than counted for the record, because
    // every queued operation becomes a commit once the turn ends. Refusing with
    // a reason lets the model wind up and report; dropping the call silently
    // would leave it convinced the edit had been made.
    if (sink.length >= maxToolCalls) {
      return refuse(
        tool,
        `Operation budget spent: a single turn may queue at most ${maxToolCalls} changes. Tell the user what you have already queued and ask them to continue in a new message.`,
      );
    }

    sink.push(mutation);
    // Applied to the projection in the same breath, so the next call validates
    // against a project that includes this one. Without this, `connect` after
    // `add_module` could only be checked against a canvas the module is not on.
    projection.apply(mutation);
    record({
      kind: "tool",
      tool,
      summary: describeMutation(mutation),
      ok: true,
    });
    // `remaining`, not only `pending`. Told how much it has spent and never how
    // much is left, the model could not ration: it filled a hundred operations
    // with configuration values and discovered the ceiling at the refusal, by
    // which point the wiring that made the stack work was still unqueued.
    return {
      queued: true,
      pending: sink.length,
      remaining: maxToolCalls - sink.length,
    };
  };

  /**
   * Whether a module really has the input a call names.
   *
   * `null` when there is nothing to object to — including when the module's ports
   * are unknown, which happens for a `module` block written by hand against a
   * source we never imported. Validation stands down there rather than refusing
   * every edit to a block it cannot describe.
   */
  const checkInput = (target: string, input: string): string | null => {
    const module = projection.module(target);
    if (!module || !module.portsKnown) return null;
    if (module.inputs.some((port) => port.name === input)) return null;

    const suggestion = closestName(
      input,
      module.inputs.map((port) => port.name),
    );
    const required = module.inputs
      .filter((port) => port.required)
      .map((port) => port.name);

    return `${target} declares no input called "${input}".${
      suggestion ? ` Did you mean "${suggestion}"?` : ""
    } Its required inputs are ${required.join(", ") || "none"}; call describe_module for the full list. Terraform rejects an argument a module does not declare, so this cannot be committed as written.`;
  };

  /** The same question for an output, which is what a wrong `connect` gets wrong. */
  const checkOutput = (source: string, output: string): string | null => {
    const module = projection.module(source);
    if (!module || !module.portsKnown) return null;
    if (module.outputs.some((port) => port.name === output)) return null;

    const suggestion = closestName(
      output,
      module.outputs.map((port) => port.name),
    );

    return `${source} has no output called "${output}".${
      suggestion ? ` Did you mean "${suggestion}"?` : ""
    } It exposes ${module.outputs.map((port) => port.name).join(", ") || "no outputs"}.`;
  };

  /**
   * One module in full, resolved from whatever the model called it.
   *
   * Three ways of naming the same thing arrive here, because all three are natural
   * to write and refusing two of them would cost a turn a call each time: the
   * library id `add_module` takes, the block label everything else takes, and the
   * module's own name, which is what a human would say.
   */
  const describeModule = async (wanted: string) => {
    const needle = wanted.trim();
    if (!needle) {
      return refuse("describe_module", "Pass the module to describe.");
    }

    const fromLibrary =
      context.library.find((module) => module.id === needle) ??
      context.library.find(
        (module) => module.name.toLowerCase() === needle.toLowerCase(),
      );

    const placed = projection.module(needle);

    if (!fromLibrary && !placed) {
      const suggestion = closestName(needle, [
        ...context.library.map((module) => module.name),
        ...projection.moduleNames(),
      ]);
      return refuse(
        "describe_module",
        `Nothing called "${needle}" in the library or on the canvas.${
          suggestion ? ` Did you mean "${suggestion}"?` : ""
        }`,
      );
    }

    // The library copy carries declared types, defaults and inferred output
    // types; a placed block whose module we never imported carries only names.
    // Prefer the richer one, and fall back rather than refusing.
    const source = fromLibrary ?? {
      id: placed?.moduleId ?? needle,
      name: placed?.moduleName ?? needle,
      versionTag: placed?.version ?? null,
      description: null,
      tags: [] as string[],
      inputs: placed?.inputs ?? [],
      outputs: placed?.outputs ?? [],
    };

    const inputs = source.inputs.slice(0, DESCRIBE_PORT_LIMIT);
    const outputs = source.outputs.slice(0, DESCRIBE_PORT_LIMIT);

    record({
      kind: "tool",
      tool: "describe_module",
      summary: `Looked up ${source.name}`,
      ok: true,
    });

    return {
      moduleId: source.id,
      name: source.name,
      ...(source.versionTag ? { version: source.versionTag } : {}),
      ...(source.description ? { description: source.description } : {}),
      ...(source.tags.length ? { tags: source.tags } : {}),
      ...(placed
        ? {
            onCanvasAs: placed.name,
            argumentsSet: Object.entries(placed.values).map(
              ([input, value]) => `${input} = ${value}`,
            ),
          }
        : { onCanvas: false }),
      inputs: inputs.map(renderPort),
      ...(source.inputs.length > inputs.length
        ? {
            inputsTruncated: `${source.inputs.length - inputs.length} optional input(s) not shown; required inputs are always listed first.`,
          }
        : {}),
      outputs: outputs.map(renderPort),
      ...(source.outputs.length > outputs.length
        ? {
            outputsTruncated: `${source.outputs.length - outputs.length} output(s) not shown.`,
          }
        : {}),
      ...(await describeCost(source.id, context)),
    };
  };

  return [
    defineTool<{ moduleId: string; name?: string }>("add_module", {
      ...spec("add_module"),
      handler: async ({ moduleId, name }) => {
        if (!context.library.some((mod) => mod.id === moduleId)) {
          return refuse("add_module", unknownLibraryModule(moduleId, context));
        }

        // Resolved here and passed on rather than left to the commit: a collision
        // renames the block, and an agent that wires to the name it asked for
        // would wire to nothing. `uniqueBlockLabel` leaves an already-free name
        // alone, so the commit lands on this exact label.
        const label = projection.labelFor(moduleId, name);

        const result = queue("add_module", {
          action: "add-module",
          moduleId,
          name: label,
        });
        if ("error" in result) return result;

        const module = projection.module(label);
        const wired = Object.entries(module?.values ?? {});

        return {
          ...result,
          name: label,
          ...(label !== name?.trim() && name?.trim()
            ? { renamedFrom: name.trim() }
            : {}),
          // Stated because it is invisible otherwise: adding a module wires its
          // unambiguous required inputs, and an agent that did not know would
          // spend operations connecting what is already connected.
          ...(wired.length
            ? {
                autoWired: wired.map(([input, value]) => `${input} = ${value}`),
              }
            : {}),
          // From `unwiredInputs` rather than `gaps`, which on this library is
          // always empty: nothing declares a required variable, so the module
          // arrived looking finished and unattached at the same time.
          stillUnset: projection
            .unwiredInputs()
            .filter((entry) => entry.module === label)
            .map((entry) => `${entry.input} (${entry.sources.join(" or ")})`),
        };
      },
    }),
    defineTool<{ module: string }>("describe_module", {
      ...spec("describe_module"),
      handler: async ({ module }) => describeModule(module),
    }),
    defineTool<{ name: string }>("remove_module", {
      ...spec("remove_module"),
      handler: async ({ name }) =>
        hasNode(name)
          ? queue("remove_module", { action: "remove-module", name })
          : refuse("remove_module", unknownModule(name, projection)),
    }),
    defineTool<{ name: string }>("auto_connect", {
      ...spec("auto_connect"),
      handler: async ({ name }) => {
        if (!hasNode(name)) {
          return refuse("auto_connect", unknownModule(name, projection));
        }

        // Asked of the projection before queueing, because the mutation would
        // otherwise fail at commit time on a module with nothing to fill — and a
        // refusal the agent can read is worth more than an error after the turn.
        const before = projection.module(name)?.values ?? {};
        const wirable = projection
          .unwiredInputs()
          .filter((entry) => entry.module === name && entry.kind === "wirable");

        if (wirable.length === 0) {
          const open = projection
            .unwiredInputs()
            .filter((entry) => entry.module === name);

          return refuse(
            "auto_connect",
            `Nothing on the canvas unambiguously fits an input of ${name}.${
              open.length
                ? ` Still unset and worth a decision: ${open
                    .map(
                      (entry) =>
                        `${entry.input} (${entry.sources.join(" or ")})`,
                    )
                    .join(", ")}. Use connect.`
                : ""
            }`,
          );
        }

        const result = queue("auto_connect", { action: "auto-connect", name });
        if ("error" in result) return result;

        const after = projection.module(name)?.values ?? {};

        return {
          ...result,
          wired: Object.entries(after)
            .filter(([input]) => before[input] === undefined)
            .map(([input, value]) => `${input} = ${value}`),
          stillUnset: projection
            .unwiredInputs()
            .filter((entry) => entry.module === name)
            .map((entry) => `${entry.input} (${entry.sources.join(" or ")})`),
        };
      },
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
            return refuse("connect", unknownModule(side, projection));
          }
        }
        // The ports, not just the blocks. This is the call the agent most often
        // gets subtly wrong — the two module names are in the prompt, the output
        // name is not — and a wrong port name is written as given, plans, and
        // fails only when somebody runs Terraform.
        const badOutput = checkOutput(args.source, args.sourceOutput);
        if (badOutput) return refuse("connect", badOutput);

        const badInput = checkInput(args.target, args.targetInput);
        if (badInput) return refuse("connect", badInput);

        return queue("connect", { action: "connect", ...args });
      },
    }),
    defineTool<{ target: string; targetInput: string }>("disconnect", {
      ...spec("disconnect"),
      handler: async ({ target, targetInput }) => {
        if (!hasNode(target)) {
          return refuse("disconnect", unknownModule(target, projection));
        }
        if (!projection.isSet(target, targetInput)) {
          return refuse(
            "disconnect",
            `${target}.${targetInput} has no value to clear.${
              checkInput(target, targetInput)
                ? " It is not an input of that module either."
                : ""
            }`,
          );
        }
        // Sent to the variable tool rather than done here, so that switching one
        // of the two off is a real restriction. Both end in the same mutation, so
        // without this check the module tool would quietly cover both.
        if (projection.readsLocal(target, targetInput)) {
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
          return refuse("edit_module", unknownModule(name, projection));
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

        // Checked before anything is queued, so a call that sets three arguments
        // and misspells the third does not half-apply. `set-argument` writes
        // whatever it is given: an undeclared argument is a configuration
        // Terraform rejects outright, and a list input given a bare string is one
        // it rejects on type — neither is visible until somebody runs a plan.
        const module = projection.module(name);
        for (const entry of settings) {
          const badInput = checkInput(name, entry.input);
          if (badInput) return refuse("edit_module", badInput);

          const declared = module?.inputs.find(
            (port) => port.name === entry.input,
          );
          const mismatch = checkValueAgainstType(
            declared?.type,
            coerceHclValue(entry.value),
          );
          if (mismatch) {
            return refuse("edit_module", `${name}.${entry.input} ${mismatch}`);
          }
        }

        // Arguments first: after a rename they would have to name the module by
        // its new label, and queueing them in this order means the model does not
        // have to reason about that.
        //
        // One mutation for all of them, which is one commit and one unit of
        // budget. As a mutation each, configuring a database spent eleven of the
        // hundred a turn has — and the turn that built this stack spent eighty of
        // them on arguments and then had none left to wire anything together.
        if (settings.length > 0) {
          const result = queue("edit_module", {
            action: "set-arguments",
            name,
            values: settings.map((entry) => ({
              input: entry.input,
              value: entry.value,
            })),
          });
          if ("error" in result || !newName) return result;
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
        if (connectTo) {
          if (!hasNode(connectTo.target)) {
            return refuse(
              "add_local",
              unknownModule(connectTo.target, projection),
            );
          }
          const badInput = checkInput(connectTo.target, connectTo.targetInput);
          if (badInput) return refuse("add_local", badInput);
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
            return refuse("edit_local", unknownLocal(name, projection));
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
          : refuse("remove_local", unknownLocal(name, projection)),
    }),
    defineTool<{ local: string; target: string; targetInput: string }>(
      "connect_local",
      {
        ...spec("connect_local"),
        handler: async ({ local, target, targetInput }) => {
          if (!hasLocal(local)) {
            return refuse("connect_local", unknownLocal(local, projection));
          }
          if (!hasNode(target)) {
            return refuse("connect_local", unknownModule(target, projection));
          }
          const badInput = checkInput(target, targetInput);
          if (badInput) return refuse("connect_local", badInput);

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
          return refuse("disconnect_local", unknownModule(target, projection));
        }
        if (!projection.readsLocal(target, targetInput)) {
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

        // Charged only when a request is actually made. The budget exists to cap
        // GitHub traffic, so listing a second subtree of a tree already in hand
        // must not cost the turn one of its forty reads.
        if (!appTree) {
          const spend = spendRead("list_app_files");
          if (spend) return spend;
        }

        try {
          const tree = await loadAppTree(appRepo);

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
            // A different kind of incompleteness, and the dangerous one: the cap
            // above is ours and `path` gets past it, while this one is GitHub's
            // and nothing gets past it. Said plainly because the wrong conclusion
            // — "this repository has no Dockerfile" — is one the agent would
            // otherwise draw with confidence and build on.
            ...(tree.truncated
              ? {
                  incomplete:
                    "GitHub could not list this repository in full, so paths may be missing entirely. Do not conclude a file is absent because it is not here; ask the user instead.",
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
          const file = await readRepoFile(appRepo.token, {
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
    defineTool<{
      summary: string;
      modules?: Array<{ moduleId: string; name?: string; purpose?: string }>;
      wiring?: Array<{
        target: string;
        targetInput: string;
        source?: string;
        sourceOutput?: string;
      }>;
    }>("propose_plan", {
      ...spec("propose_plan"),
      handler: async ({ summary, modules, wiring }) => {
        const text = summary?.trim();
        if (!text) {
          return refuse("propose_plan", "Say what the plan is.");
        }

        const planned = modules ?? [];
        // Named against the library while it is still only a plan. "I will add the
        // ECS module" is worth correcting before three other modules are wired to
        // a block that was never going to exist.
        const unknown = planned
          .map((entry) => entry.moduleId)
          .filter((id) => !context.library.some((mod) => mod.id === id));

        record({
          kind: "tool",
          tool: "propose_plan",
          summary: [
            text,
            ...planned.map(
              (entry) =>
                `+ ${entry.name ?? entry.moduleId}${entry.purpose ? ` — ${entry.purpose}` : ""}`,
            ),
            ...(wiring ?? []).map(
              (wire) =>
                `→ ${wire.target}.${wire.targetInput} = ${
                  wire.source
                    ? `${wire.source}.${wire.sourceOutput ?? "?"}`
                    : "(to decide)"
                }`,
            ),
          ].join("\n"),
          ok: true,
        });

        return {
          recorded: true,
          ...(unknown.length
            ? {
                problem: `Not in the library: ${unknown.join(", ")}. Pick real ids before building — check the library list in your instructions.`,
              }
            : {}),
          // The turn is headless: nobody can answer a question in the middle of
          // it. So a plan the user should weigh in on has to end the turn, and
          // the confirmation arrives as their next message.
          guidance:
            planned.length > PLAN_CONFIRM_THRESHOLD
              ? `This plan adds ${planned.length} modules. Unless the user has already told you to go ahead, answer with the plan now and ask them to confirm — do not queue the edits in this turn.`
              : "Now build it, then call review_project before you answer.",
        };
      },
    }),
    defineTool<Record<string, never>>("review_project", {
      ...spec("review_project"),
      handler: async () => {
        const problems = projection.problems();
        const of = (severity: ProblemSeverity) =>
          problems
            .filter((problem) => problem.severity === severity)
            .map((problem) => problem.message);

        const blocking = of("blocking");
        const incomplete = of("incomplete");

        record({
          kind: "tool",
          tool: "review_project",
          summary:
            blocking.length || incomplete.length
              ? [
                  blocking.length ? `${blocking.length} blocking` : null,
                  incomplete.length ? `${incomplete.length} unfinished` : null,
                ]
                  .filter(Boolean)
                  .join(", ")
              : "Projected configuration is complete",
          ok: blocking.length === 0 && incomplete.length === 0,
        });

        return {
          queuedOperations: sink.length,
          remaining: maxToolCalls - sink.length,
          modules: projection.allModules().map((module) => module.name),
          variables: projection.allLocals().map((local) => local.name),
          // Three lists rather than two, because there are three answers. The
          // middle one is the one that was missing: a configuration can plan
          // perfectly and still describe infrastructure that cannot work.
          blocking,
          incomplete,
          advisory: of("advisory"),
          verdict: blocking.length
            ? "Fix these before answering. Every one of them stops `terraform plan`."
            : incomplete.length
              ? "This plans, but it does not work: the modules listed under `incomplete` are not attached to anything. Wire them, or tell the user which ones you deliberately left open and why."
              : "Nothing left unfilled. Say what you changed.",
        };
      },
    }),
    // Withheld rather than refused at call time: a tool the model cannot see is
    // one it will not promise the user and then fail to deliver.
  ].filter((tool) => !disabled.has(tool.name));
}

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
function describeAppRepoError(error: unknown, appRepo: AgentAppRepo): string {
  if (error instanceof GithubRequestError) {
    if (error.status === 404) {
      // No longer guesses at whose access lapsed. The link was verified against
      // this very credential when it was set and again at the start of this turn,
      // so a 404 here means something changed since — or the path is simply wrong.
      return `Cannot reach ${appRepo.fullName} at ${appRepo.branch}, although the link was readable when this turn began. Tell the user the application repository has become unreachable; do not retry.`;
    }
    if (error.status === 401 || error.status === 403) {
      return `Not allowed to read ${appRepo.fullName}. Tell the user the GitHub access this installation was granted needs checking; do not retry.`;
    }
  }

  return `Could not read ${appRepo.fullName}: ${error instanceof Error ? error.message : "unknown error"}.`;
}

/**
 * Appends a step, dropping the overflow rather than the earliest context.
 *
 * Two things it will not do silently. Thoughts stop being recorded before the
 * record is full, so a narrating model cannot crowd out the operations — those are
 * the audit trail of what reached the repository. And the last slot is spent
 * saying the trail was cut, because a trail that simply stops looks exactly like a
 * turn that stopped, which is how eighty committed operations came to be invisible.
 */
function pushStep(steps: AgentStep[], step: AgentStep): void {
  if (steps.length >= MAX_STEPS) return;

  if (steps.length === MAX_STEPS - 1) {
    steps.push({
      kind: "tool",
      tool: "trail",
      summary: `Only the first ${MAX_STEPS - 1} entries of this turn were recorded. The operations after them still ran and still committed.`,
      ok: true,
    });
    return;
  }

  if (step.kind === "thought") {
    const thoughts = steps.reduce(
      (count, entry) => count + (entry.kind === "thought" ? 1 : 0),
      0,
    );
    if (thoughts >= AGENT_MAX_THOUGHTS) return;
  }

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
    case "set-arguments":
      return mutation.values.length === 1 && mutation.values[0]
        ? `Set ${mutation.name}.${mutation.values[0].input}`
        : `Set ${mutation.values.length} arguments on ${mutation.name}`;
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
 * What a set of resources does to the bill, for a `describe_module` answer.
 *
 * Structural, never an amount — the numbers that decide a bill are inputs supplied
 * at deploy time, so the same module is twenty euros a month or twenty thousand.
 * What is answerable from source is which resources bill for existing, and that is
 * the fact worth having *before* placing three of them.
 *
 * Returns nothing at all when the lookup is unavailable or the module has no
 * resources recorded. A section that says "unknown" would read as "free".
 */
async function describeCost(
  moduleId: string,
  context: AgentContext,
): Promise<Record<string, unknown>> {
  if (!context.moduleResources) return {};

  const resources = await context
    .moduleResources([moduleId])
    .then((byModule) => byModule[moduleId] ?? [])
    .catch(() => []);

  if (resources.length === 0) return {};

  const cost = summariseCost(resources);

  return {
    cost: {
      ...(cost.recurring.length
        ? {
            billsWhileItExists: cost.recurring.map((entry) =>
              entry.driver
                ? `${entry.resourceType}: ${entry.driver}`
                : entry.resourceType,
            ),
          }
        : {}),
      ...(cost.usage.length
        ? {
            billsByUsage: cost.usage.map((entry) => entry.resourceType),
          }
        : {}),
      freeResources: cost.freeCount,
      ...(cost.unclassified.length
        ? { notClassified: cost.unclassified.slice(0, 10) }
        : {}),
      note: cost.recurring.length
        ? "The resources above accrue from the moment they are created. Say so when you place this, and mention which input controls how many there are."
        : "Nothing here bills merely for existing.",
    },
  };
}

/** Said the same way wherever a library id turns out not to name a module. */
function unknownLibraryModule(moduleId: string, context: AgentContext): string {
  const suggestion = closestName(moduleId, [
    ...context.library.map((module) => module.id),
    ...context.library.map((module) => module.name),
  ]);

  return `No module "${moduleId}" in the library.${
    suggestion ? ` Did you mean "${suggestion}"?` : ""
  } The library section of your instructions lists every id; add_module takes the id, not the name.`;
}

function unknownLocal(name: string, projection: GraphProjection): string {
  const known = projection.localNames();
  const suggestion = closestName(name, known);

  return `No value "${name}" in this project.${
    suggestion ? ` Did you mean "${suggestion}"?` : ""
  } Available: ${known.join(", ") || "none"}.`;
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

/**
 * Read from the projection rather than the graph, so a block this turn added
 * counts as present and a block it removed does not.
 */
function unknownModule(name: string, projection: GraphProjection): string {
  const known = projection.moduleNames();
  const suggestion = closestName(name, known);

  return `There is no module block called "${name}".${
    suggestion ? ` Did you mean "${suggestion}"?` : ""
  } On the canvas: ${known.join(", ") || "nothing yet"}.`;
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
function openInputs(context: AgentContext): string[] {
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
    `You are the TerraBlox agent for the project "${context.projectName}", backed by ${context.repoFullName} on branch ${context.branch}.`,
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
function describeModuleHeading(node: {
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
function describePorts(node: {
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
function pipelineNotice(
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
function recallConversation(
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
