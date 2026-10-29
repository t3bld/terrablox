import "server-only";

import { type CopilotSession, defineTool } from "@github/copilot-sdk";
import {
  KNOWLEDGE_APP_REPO,
  KNOWLEDGE_MODULE_LIBRARY,
  knowledgeEnabled,
} from "@terrablox/agent-harness/knowledge";
import {
  AGENT_APP_REPO_FILE_CHARS,
  AGENT_APP_REPO_IGNORED_DIRS,
  AGENT_APP_REPO_TREE_LIMIT,
  AGENT_MAX_APP_REPO_READS,
  AGENT_MAX_MCP_CALLS,
  AGENT_MAX_STEPS,
  AGENT_MAX_TOOL_CALLS,
  DEFAULT_TURN_TIMEOUT_SECONDS,
  maxThoughtsFor,
} from "@terrablox/agent-harness/runtime-options";
import { PROJECT_AGENT_TOOLS } from "@terrablox/agent-harness/tool-catalogue";
import { GithubRequestError } from "@terrablox/git/client";
import { listRepoTree, readRepoFile } from "@terrablox/git/files";
import { checkValueAgainstType } from "@terrablox/terraform/type-check";
import { isValidLocalName } from "@/lib/projects/locals";
import type {
  AgentStep,
  AgentToolCall,
  AgentTurnTelemetry,
  AgentTurnUsage,
  ProjectGraphMutation,
} from "@/lib/projects/types";
import { coerceHclValue } from "@/lib/projects/wiring";
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
import { DESCRIBE_PORT_LIMIT, renderPort, summariseCost } from "./library-view";
import { systemPrompt } from "./prompt";
import type { AgentAppRepo, AgentContext } from "./turn-context";

/**
 * The project agent.
 *
 * The agent's only way to change a project is the same mutation set the canvas
 * uses, so whatever it does arrives in the repository through one code path and
 * shows up in the graph exactly like a manual edit. The model is Copilot,
 * running on the signed-in user's own subscription.
 */

/** Tool definitions, in the shape function-calling APIs expect. */
export { PROJECT_AGENT_TOOLS } from "@terrablox/agent-harness/tool-catalogue";

/**
 * A decision the turn recorded, ready to be written.
 *
 * Queued rather than persisted during the turn, for the reason mutations are: the
 * agent changes nothing while it works, and the app decides afterwards what to
 * keep. A decision that reached the database from a turn that then failed would be
 * a recorded reason for infrastructure that does not exist.
 */
export interface RecordedDecision {
  question: string;
  context: string;
  choice: string;
  reason: string;
  alternatives: Array<{ option: string; reason: string }>;
  plan: {
    modules: Array<{ moduleId: string; name?: string; purpose?: string }>;
    wiring: Array<{
      target: string;
      targetInput: string;
      source?: string;
      sourceOutput?: string;
    }>;
  };
  /** Decision this one replaces, when the turn changed an earlier answer. */
  supersedes?: string;
  /**
   * Index into `mutations` from which this decision is in force.
   *
   * The two queues share one order, so the decision an operation belongs to is the
   * last one recorded before it. That is what lets a turn record "use Postgres",
   * build it, then record "three availability zones" and build that, without the
   * second decision claiming the first one's commits.
   */
  fromMutation: number;
}

/**
 * One application-repository read the agent made, captured in full.
 *
 * The step trail only keeps a summary — "Read services/api/Dockerfile" — which is
 * enough for a person watching the turn and useless as training data: the content
 * the agent reasoned from is gone. This keeps what the agent actually saw, which
 * is the starting state of a migration whose source is a codebase rather than a
 * graph. `content` is what the tool returned, so it is already capped at
 * `appRepoFileChars` and `truncated` says whether more existed. A listing has no
 * content; its `paths` are the file names the agent was shown.
 */
export interface AppRepoRead {
  kind: "file" | "listing";
  path: string;
  /** The ref the read was pinned to, i.e. the app repo's resolved branch. */
  ref: string;
  /** File content as the agent saw it, capped. Absent for a listing. */
  content?: string;
  /** The file names a listing returned. Absent for a file read. */
  paths?: string[];
  /** True when the content or listing was cut to fit the budget. */
  truncated: boolean;
}

/**
 * One MCP tool call the agent made, as far as it can be observed.
 *
 * MCP servers are a migration source in their own right — an inventory API, a CMDB,
 * a cloud account read through somebody's own server. The permission handler sees
 * the request but not the result: the SDK routes the result straight back to the
 * model. So `result` is best-effort and usually absent, and `resultCaptured` says
 * which it is, rather than letting an empty result read as "the call returned
 * nothing".
 */
export interface McpCall {
  server: string;
  tool: string;
  /** The server's own claim, not verified here. */
  readOnly: boolean;
  /** The call's arguments, as the runtime reported them on the start event. */
  args?: unknown;
  /**
   * What the call returned: the tool's verbatim JSON when it gave any, else the
   * text the model was handed. Present only once `resultCaptured` is true.
   */
  result?: unknown;
  /** Whether the server's own `success` flag was true. Absent until completion. */
  success?: boolean;
  /** The error message when the call failed. */
  error?: string;
  /**
   * Whether the result above was observed.
   *
   * A call that was budget-rejected, or whose completion event never arrived,
   * leaves this false. It stops an absent result from reading as "the call
   * returned nothing", which for a migration source is a materially different
   * fact.
   */
  resultCaptured: boolean;
}

/**
 * Everything the agent read as the starting state of this turn, beyond the graph.
 *
 * Collected during the turn because none of it survives in the step trail. Empty
 * arrays are the common case — a greenfield or graph-only turn reads neither an app
 * repo nor an MCP server — and that emptiness is itself the signal that the turn was
 * not a migration from an external source.
 */
export interface MigrationSourceCapture {
  appRepoReads: AppRepoRead[];
  mcpCalls: McpCall[];
}

export interface AgentTurn {
  reply: string;
  /** Mutations to apply, in order. Empty when the turn only answers. */
  mutations: ProjectGraphMutation[];
  /** Decisions to record, in the order they were made. */
  decisions: RecordedDecision[];
  /**
   * The UI trail: capped and truncated, in the order it happened.
   *
   * What the chat shows live and stores on the assistant message. For a faithful
   * record of the turn use `fullSteps`.
   */
  steps: AgentStep[];
  /**
   * The complete trail: every step, every thought, at full length.
   *
   * The same events as `steps` but before `pushStep` dropped or truncated any of
   * them. This is what the harness trains on; `steps` is only for display.
   */
  fullSteps: AgentStep[];
  /**
   * What the agent read as the turn's starting state, beyond the project graph.
   *
   * The app-repo files and MCP results that a migration transforms *from*. Kept
   * separately from `steps` because the trail is a lossy summary and this is the
   * faithful copy the harness trains on.
   */
  migrationSource: MigrationSourceCapture;
  /** Exact SDK calls, token usage and timing for the user-facing log. */
  telemetry: AgentTurnTelemetry;
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

/**
 * The operations that delete something, and every reference to it.
 *
 * Named here rather than flagged in the catalogue because this is the agent's
 * question, not the catalogue's: the same operations remain available on the
 * canvas, where a person is looking at what they are removing.
 */
const DESTRUCTIVE_TOOLS = ["remove_module", "remove_local"] as const;

/**
 * How much of one reasoning summary the UI trail keeps.
 *
 * The trail is stored on the message and sent to every client that loads the
 * transcript, so a thought still has a ceiling — but the detail panel now writes
 * it out in full rather than as a single clipped line, and at 600 the panel was
 * cutting the model mid-sentence on exactly the turns worth reading. 2000 holds a
 * whole concise summary; `reasoningSummary: "concise"` keeps these short on its
 * own, so this is a guard against an outlier, not the common length.
 */
const MAX_THOUGHT_LENGTH = 2000;

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
 * Thrown when a turn was stopped on purpose, rather than having gone wrong.
 *
 * Its own type because every caller has to treat it differently from a failure:
 * nothing is diagnosed, the Copilot client is kept (it is healthy — we interrupted
 * it), and the queued edits are dropped rather than committed. A user who presses
 * Stop is not reporting a bug.
 */
export class TurnCancelled extends Error {
  constructor() {
    super("The turn was stopped.");
    this.name = "TurnCancelled";
  }
}

/**
 * Rejects with {@link TurnCancelled} as soon as `signal` fires, or settles with the
 * turn.
 *
 * A race is the only shape available: `sendAndWait` takes a millisecond timeout and
 * no signal, so there is nothing to hand a cancellation to. The listener is removed
 * either way — a signal that outlives the turn would otherwise keep a reference to
 * a finished one for as long as the request lives.
 */
function raceCancellation<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(new TurnCancelled());

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new TurnCancelled());
    signal.addEventListener("abort", onAbort, { once: true });

    work.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

export async function runProjectAgent(
  message: string,
  context: AgentContext,
): Promise<AgentTurn> {
  const mutations: ProjectGraphMutation[] = [];
  const decisions: RecordedDecision[] = [];
  // The UI trail: capped and truncated, shown live in the chat and stored on the
  // assistant message. `fullSteps` is its untrimmed twin, for the training record.
  const steps: AgentStep[] = [];
  const fullSteps: AgentStep[] = [];
  // The faithful copy of what the agent read, collected inside the tools and the
  // MCP handler. Returned beside `steps`, which only summarises these.
  const appRepoReads: AppRepoRead[] = [];
  const mcpCaptures: McpCall[] = [];
  // Open MCP calls keyed by the runtime's tool-call id, so the completion event
  // can attach its result to the record the start event opened.
  const mcpCallsById = new Map<string, McpCall>();

  /**
   * Exact SDK telemetry for the user-facing log.
   *
   * This is deliberately separate from `steps`: one hand-written step can cover
   * more than one queued mutation, while a tool call is an SDK fact with its own
   * id, arguments, result and timestamps.
   */
  const telemetryStartedAt = new Date().toISOString();
  const telemetryStartedMs = performance.now();
  let telemetryFinishedAt: string | null = null;
  let agentDurationMs: number | null = null;
  const toolCalls: AgentToolCall[] = [];
  const toolCallsById = new Map<string, AgentToolCall>();
  const usage: AgentTurnUsage = {
    modelCalls: 0,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    apiDurationMs: null,
    cost: null,
    totalNanoAiu: null,
  };

  const addUsage = (
    current: number | null,
    next: number | undefined,
  ): number | null => (next === undefined ? current : (current ?? 0) + next);

  const telemetrySnapshot = (): AgentTurnTelemetry => ({
    startedAt: telemetryStartedAt,
    finishedAt: telemetryFinishedAt,
    agentDurationMs,
    // The route fills this after applying mutations and persisting the reply.
    totalDurationMs: null,
    usage: { ...usage },
    toolCalls: toolCalls.map((call) => ({ ...call })),
  });

  const publishTelemetry = () => context.onTelemetry?.(telemetrySnapshot());
  const finishTelemetry = (): AgentTurnTelemetry => {
    if (!telemetryFinishedAt) {
      telemetryFinishedAt = new Date().toISOString();
      agentDurationMs = Math.round(performance.now() - telemetryStartedMs);
    }
    const snapshot = telemetrySnapshot();
    context.onTelemetry?.(snapshot);
    return snapshot;
  };

  /**
   * The caps this turn runs under, resolved once.
   *
   * Read here rather than at each use so a turn cannot end up enforcing two
   * different numbers, and so the fallback to the default appears once instead of
   * beside every reference.
   */
  const trail = {
    maxSteps: context.maxSteps ?? AGENT_MAX_STEPS,
    maxThoughts: maxThoughtsFor(context.maxSteps ?? AGENT_MAX_STEPS),
  };
  /**
   * Records a step and tells the caller, so progress is visible while the turn
   * is still running rather than only in the finished message.
   */
  const record = (step: AgentStep) => {
    // The full trail first, untouched: every step, every thought, at full
    // length. `pushStep` then adds the same step to the UI trail under its caps,
    // dropping and truncating as it must. The two diverge only once a turn is
    // long enough to hit a cap, which is exactly the turn the harness most wants
    // to see in full.
    fullSteps.push(step);
    pushStep(steps, step, trail);
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
      tools: buildTools(context, mutations, decisions, record, appRepoReads),
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

        // One user turn contains several model calls as the model alternates with
        // tools. The SDK emits usage per call, so sum every optional metric while
        // preserving null when the provider never reported that metric at all.
        if (event.type === "assistant.usage") {
          usage.modelCalls += 1;
          usage.inputTokens = addUsage(
            usage.inputTokens,
            event.data.inputTokens,
          );
          usage.outputTokens = addUsage(
            usage.outputTokens,
            event.data.outputTokens,
          );
          usage.cacheReadTokens = addUsage(
            usage.cacheReadTokens,
            event.data.cacheReadTokens,
          );
          usage.cacheWriteTokens = addUsage(
            usage.cacheWriteTokens,
            event.data.cacheWriteTokens,
          );
          usage.reasoningTokens = addUsage(
            usage.reasoningTokens,
            event.data.reasoningTokens,
          );
          usage.apiDurationMs = addUsage(
            usage.apiDurationMs,
            event.data.duration,
          );
          usage.cost = addUsage(usage.cost, event.data.cost);
          usage.totalNanoAiu = addUsage(
            usage.totalNanoAiu,
            event.data.copilotUsage?.totalNanoAiu,
          );
          publishTelemetry();
          return;
        }

        // Every SDK tool call, ours and MCP alike. The result event below carries
        // the complete result envelope the runtime observed, including structured
        // MCP content and detailed text where present.
        if (event.type === "tool.execution_start") {
          const { mcpServerName, mcpToolName, arguments: args } = event.data;
          const call: AgentToolCall = {
            id: event.data.toolCallId,
            source: mcpServerName ? "mcp" : "terrablox",
            tool: mcpToolName ?? event.data.toolName,
            server: mcpServerName ?? null,
            arguments: args ?? null,
            result: null,
            success: null,
            error: null,
            startedAt: event.timestamp,
            finishedAt: null,
            durationMs: null,
          };
          toolCalls.push(call);
          toolCallsById.set(call.id, call);

          if (mcpServerName) {
            const mcpCall: McpCall = {
              server: mcpServerName,
              tool: mcpToolName ?? event.data.toolName,
              // The permission handler fills the server's own read-only claim.
              readOnly: false,
              args,
              resultCaptured: false,
            };
            mcpCaptures.push(mcpCall);
            mcpCallsById.set(event.data.toolCallId, mcpCall);
          }
          publishTelemetry();
          return;
        }

        if (event.type === "tool.execution_complete") {
          const call = toolCallsById.get(event.data.toolCallId);
          if (call) {
            call.finishedAt = event.timestamp;
            call.durationMs = Math.max(
              0,
              Date.parse(event.timestamp) - Date.parse(call.startedAt),
            );
            call.success = event.data.success;
            call.result = event.data.result ?? null;
            call.error = event.data.error?.message ?? null;
          }

          // Keep the existing full migration-source capture for training too.
          const mcpCall = mcpCallsById.get(event.data.toolCallId);
          if (mcpCall) {
            mcpCall.resultCaptured = true;
            mcpCall.success = event.data.success;
            mcpCall.result =
              event.data.result?.structuredContent ??
              event.data.result?.content;
            if (event.data.error) mcpCall.error = event.data.error.message;
          }
          publishTelemetry();
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

          // The call itself is captured in `onEvent` (start + complete), which is
          // the only place the result is observable. The permission request adds
          // the one fact those events lack: the server's `readOnly` claim. Stamp
          // it onto the newest open call for this server+tool that has not yet
          // been annotated, so the training record carries it too.
          for (let i = mcpCaptures.length - 1; i >= 0; i--) {
            const call = mcpCaptures[i];
            if (
              call &&
              call.server === request.serverName &&
              call.tool === request.toolName &&
              !call.readOnly
            ) {
              call.readOnly = Boolean(request.readOnly);
              break;
            }
          }

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

    const response = await raceCancellation(
      session.sendAndWait({ prompt: message }, timeoutMs),
      context.signal,
    );
    const telemetry = finishTelemetry();

    return {
      reply:
        response?.data.content?.trim() ||
        "I could not put together an answer for that.",
      mutations,
      decisions,
      steps,
      fullSteps,
      migrationSource: { appRepoReads, mcpCalls: mcpCaptures },
      telemetry,
    };
  } catch (error) {
    finishTelemetry();
    // `sendAndWait` only stops *waiting* — the SDK says so plainly, and its
    // implementation races the wait against a timer. Without this the runtime
    // would carry on thinking for a turn nobody is listening to any more, on the
    // user's own Copilot quota. `abort` is the SDK's cancellation for exactly
    // that, and is harmless when nothing is in flight.
    await session?.abort().catch(() => {});

    // A stop is not a fault. Diagnosing it would rewrite "stopped" into whichever
    // Copilot error text matched, and discarding the client would throw away a
    // working CLI process because the user changed their mind.
    if (error instanceof TurnCancelled) throw error;

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
  decisions: RecordedDecision[],
  record: (step: AgentStep) => void,
  // Collects the app-repo reads in full, since the step trail only summarises
  // them. The same thread-through pattern as `sink` and `decisions`.
  appRepoReads: AppRepoRead[],
) {
  const disabled = new Set(context.disabledTools ?? []);

  /** This turn's operation budget: the caller's choice, or the default. */
  const maxToolCalls = context.maxToolCalls ?? AGENT_MAX_TOOL_CALLS;

  /** The application-repository caps, resolved the same way. */
  const maxAppRepoReads = context.maxAppRepoReads ?? AGENT_MAX_APP_REPO_READS;
  const appRepoTreeLimit =
    context.appRepoTreeLimit ?? AGENT_APP_REPO_TREE_LIMIT;
  const appRepoFileChars =
    context.appRepoFileChars ?? AGENT_APP_REPO_FILE_CHARS;

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
    if (reads >= maxAppRepoReads) {
      return refuse(
        tool,
        `Reading budget spent: a single turn may read the application repository at most ${maxAppRepoReads} times. Work with what you have already seen, and say what you were still looking for.`,
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

          const shown = files.slice(0, appRepoTreeLimit);
          const omitted = files.length - shown.length;

          // The file names the agent was shown, captured for training. A listing
          // is which paths the agent knew existed when it chose what to read —
          // part of the migration source, even though it has no file content of
          // its own. `truncated` covers both our cap and GitHub's own.
          appRepoReads.push({
            kind: "listing",
            path: prefix,
            ref: appRepo.branch,
            paths: shown,
            truncated: omitted > 0 || tree.truncated,
          });

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

          const truncated = file.content.length > appRepoFileChars;
          const seen = truncated
            ? file.content.slice(0, appRepoFileChars)
            : file.content;

          // Captured as the agent saw it — sliced to the same budget — so the
          // training record holds the input the turn reasoned from, no more. The
          // step trail keeps only the one-line summary below.
          appRepoReads.push({
            kind: "file",
            path: wanted,
            ref: appRepo.branch,
            content: seen,
            truncated,
          });

          record({
            kind: "tool",
            tool: "read_app_file",
            summary: `Read ${wanted} from ${appRepo.fullName}`,
            ok: true,
          });

          return {
            repository: appRepo.fullName,
            path: wanted,
            content: seen,
            ...(truncated
              ? {
                  truncated: `Only the first ${appRepoFileChars} characters are shown.`,
                }
              : {}),
          };
        } catch (error) {
          return refuse("read_app_file", describeAppRepoError(error, appRepo));
        }
      },
    }),
    defineTool<{
      question: string;
      context: string;
      choice: string;
      reason: string;
      alternatives?: Array<{ option: string; reason: string }>;
      plan?: {
        modules?: Array<{ moduleId: string; name?: string; purpose?: string }>;
        wiring?: Array<{
          target: string;
          targetInput: string;
          source?: string;
          sourceOutput?: string;
        }>;
      };
      supersedes?: string;
    }>("record_decision", {
      ...spec("record_decision"),
      handler: async (args) => {
        const question = args.question?.trim();
        const choice = args.choice?.trim();
        const reason = args.reason?.trim();

        if (!question || !choice || !reason) {
          return refuse(
            "record_decision",
            "A decision needs at least `question`, `choice` and `reason`. Say what was being decided, what you chose, and why.",
          );
        }

        const planned = args.plan?.modules ?? [];
        const wiring = args.plan?.wiring ?? [];

        // Named against the library while it is still only a plan. "I will add the
        // ECS module" is worth correcting before three other modules are wired to
        // a block that was never going to exist.
        const unknown = planned
          .map((entry) => entry.moduleId)
          .filter((id) => !context.library.some((mod) => mod.id === id));

        // Only a decision this project actually holds may be superseded, or the
        // log would grow a chain pointing at nothing.
        const supersedes = args.supersedes?.trim();
        const knownSupersedes = (context.decisions ?? []).some(
          (entry) => entry.id === supersedes,
        );

        decisions.push({
          question,
          context: args.context?.trim() || "(not stated)",
          choice,
          reason,
          alternatives: (args.alternatives ?? [])
            .map((entry) => ({
              option: entry.option?.trim() ?? "",
              reason: entry.reason?.trim() ?? "",
            }))
            .filter((entry) => entry.option),
          plan: { modules: planned, wiring },
          ...(supersedes && knownSupersedes ? { supersedes } : {}),
          // Everything queued from here belongs to this decision.
          fromMutation: sink.length,
        });

        record({
          kind: "tool",
          tool: "record_decision",
          summary: [
            `${question} → ${choice}`,
            `Because: ${reason}`,
            ...(args.context?.trim() ? [`Given: ${args.context.trim()}`] : []),
            ...(args.alternatives ?? []).map(
              (entry) => `Not ${entry.option}: ${entry.reason}`,
            ),
            ...planned.map(
              (entry) =>
                `+ ${entry.name ?? entry.moduleId}${entry.purpose ? ` — ${entry.purpose}` : ""}`,
            ),
            ...wiring.map(
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
          ...(supersedes && !knownSupersedes
            ? {
                note: `No decision ${supersedes} is in force on this project, so this one supersedes nothing. Check the list in your instructions.`,
              }
            : {}),
          // The turn is headless: nobody can answer a question in the middle of
          // it. So a plan the user should weigh in on has to end the turn, and
          // the confirmation arrives as their next message.
          guidance:
            planned.length > PLAN_CONFIRM_THRESHOLD
              ? `This plan adds ${planned.length} modules. Unless the user has already told you to go ahead, answer with the decision now and ask them to confirm — do not queue the edits in this turn.`
              : "Recorded. Everything you queue from now is filed under it. Build, then call review_project before you answer.",
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
function pushStep(
  steps: AgentStep[],
  step: AgentStep,
  caps: { maxSteps: number; maxThoughts: number },
): void {
  if (steps.length >= caps.maxSteps) return;

  if (steps.length === caps.maxSteps - 1) {
    steps.push({
      kind: "tool",
      tool: "trail",
      summary: `Only the first ${caps.maxSteps - 1} entries of this turn were recorded. The operations after them still ran and still committed.`,
      ok: true,
    });
    return;
  }

  if (step.kind === "thought") {
    const thoughts = steps.reduce(
      (count, entry) => count + (entry.kind === "thought" ? 1 : 0),
      0,
    );
    if (thoughts >= caps.maxThoughts) return;
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
