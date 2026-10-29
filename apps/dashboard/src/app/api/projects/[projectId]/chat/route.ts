import { NextResponse } from "next/server";

/**
 * The agent loop may run for minutes on complex tasks (many tool calls), so the
 * route must not time out before the SDK does. This only matters when deployed on
 * platforms with a per-route timeout (Vercel, Netlify); locally Next.js has none.
 */
export const maxDuration = 300; // seconds — matches SEND_AND_WAIT_TIMEOUT_MS

import {
  KNOWLEDGE_MODULE_LIBRARY,
  KNOWLEDGE_PROJECT_REPO,
  knowledgeEnabled,
} from "@terrablox/agent-harness/knowledge";
import {
  AGENT_CANCEL_POLL_MS,
  AGENT_MAX_TOOL_CALLS,
  AGENT_PROGRESS_INTERVAL_MS,
  renderOperatingRule,
} from "@terrablox/agent-harness/runtime-options";
import { Prisma } from "@terrablox/database";
import { listWorkflowRuns } from "@terrablox/git/actions";
import { GithubRequestError } from "@terrablox/git/client";
import { getBranchHead } from "@terrablox/git/files";
import { getRepository } from "@terrablox/git/repositories";
import { z } from "zod";
import {
  COPILOT_REASONING_EFFORT,
  resolveCopilotModel,
} from "@/lib/agent/copilot";
import { getEffectiveAgentSettings } from "@/lib/agent/effective-settings";
import { getHarnessCuration } from "@/lib/agent/harness-curation";
import { toAgentLibrary } from "@/lib/agent/library-view";
import { runProjectAgent, TurnCancelled } from "@/lib/agent/project-agent";
import {
  mcpServersForSession,
  REASONING_EFFORTS,
  type ReasoningEffortValue,
} from "@/lib/agent/settings-service";
import type {
  AgentAppRepo,
  AgentPipelineCheck,
} from "@/lib/agent/turn-context";
import { parseJsonBody, requireUserWithLimit } from "@/lib/api/guard";
import { RATE_LIMITS } from "@/lib/api/rate-limit";
import { routeError } from "@/lib/api/route-error";
import {
  getCurrentUserId,
  getProviderTokenForRequest,
  getUserGithubToken,
} from "@/lib/auth/server-helpers";
import { database } from "@/lib/database";
import { activeDecisions, recordDecision } from "@/lib/projects/decisions";
import { toChatMessageDto } from "@/lib/projects/serialize";
import {
  applyProjectMutation,
  findOwnedProject,
  loadProjectGraph,
  MutationError,
  readModuleLibrary,
  readModuleResourceTypes,
} from "@/lib/projects/service";
import {
  backfillPipelineOutcome,
  recordTransformation,
} from "@/lib/projects/transformations";
import type {
  AgentStep,
  AgentTurnTelemetry,
  ProjectGraph,
} from "@/lib/projects/types";

/**
 * How many messages of a project's transcript are read at once.
 *
 * The newest ones, which is worth stating because it used to be the oldest: this
 * was `orderBy: asc` with a `take`, so once a project passed the limit both the
 * chat panel and the agent were served the *first* fifty messages forever. The
 * conversation appeared to stop dead at some point in the past.
 *
 * How much of this reaches the prompt is decided separately, by
 * `AGENT_HISTORY_BUDGET_CHARS`.
 */
const HISTORY_LIMIT = 200;

/**
 * The longest message a person may send.
 *
 * Generous — an eight-thousand-character prompt is a page and a half of prose — and
 * finite, which is the property that was missing. The value is persisted and then
 * spent on the model, so an unbounded string is both a storage and a billing problem.
 */
const MAX_MESSAGE_CHARS = 8000;

/** Newest first from the database, then flipped back into reading order. */
const HISTORY_QUERY = {
  orderBy: { createdAt: "desc" },
  take: HISTORY_LIMIT,
} as const;

/**
 * The composer sends the model and effort with every turn, so nothing here is
 * trusted: an unknown id would fail the session with a runtime error instead of
 * a message the user can act on.
 *
 * Only the shape is checked here, and anything else reads as "no choice". Whether
 * the user may still run the model is `resolveCopilotModel`'s question, asked
 * against their own list before the turn starts.
 */
function requestedModel(value: unknown): string | null {
  return typeof value === "string" && /^[\w.:-]{1,100}$/.test(value)
    ? value
    : null;
}

function resolveEffort(value: unknown): ReasoningEffortValue {
  return REASONING_EFFORTS.includes(value as ReasoningEffortValue)
    ? (value as ReasoningEffortValue)
    : (COPILOT_REASONING_EFFORT as ReasoningEffortValue);
}

/**
 * The project as it looks to an agent not allowed to read it.
 *
 * Structurally a real graph so every tool's validation still works — every
 * lookup simply misses, which is exactly right: an agent that cannot see a
 * module must not be able to rename or delete it either. The sha is kept so the
 * commit path still knows which revision the turn started from.
 */
function blindGraph(sha: string): ProjectGraph {
  return {
    nodes: [],
    edges: [],
    gaps: [],
    resourceCount: 0,
    files: [],
    sha,
    errors: [],
  };
}

/**
 * The newest pipeline run on the project's own branch, or null.
 *
 * The closest thing to `terraform validate` a turn can be given. Running Terraform
 * here is not an option — it needs the binary, the providers downloaded and the
 * private module sources fetched, which is minutes of work and a network the
 * request handler should not be doing — but the user's pipeline already runs
 * exactly that on every commit. Its verdict on the previous turn is a fact, and a
 * cheap one.
 *
 * Never fatal. Reading runs needs the `actions: read` permission, which the
 * installation may not have been granted, and a turn must not fail because a
 * status could not be read.
 */
/**
 * The linked application repository, resolved and confirmed for this turn.
 *
 * Two jobs in one request, because they are the same request. A link stores a ref
 * only when one was deliberately pinned, so the usual case needs the repository's
 * *current* default branch — and asking for it is also how we find out the link
 * still works. Doing it here rather than inside the first tool call means a broken
 * link becomes a sentence in the prompt instead of a failure three minutes into a
 * turn.
 *
 * Read with the provider token: that is the credential the picker listed
 * repositories with, so it is the one that can read what the user chose.
 */
async function resolveAppRepo(
  token: string,
  project: { appRepoFullName: string | null; appRepoBranch: string | null },
): Promise<{ appRepo: AgentAppRepo | null; problem: string | null }> {
  if (!project.appRepoFullName) return { appRepo: null, problem: null };

  try {
    const repository = await getRepository(token, project.appRepoFullName);
    const branch = project.appRepoBranch ?? repository.defaultBranch;

    // The commit the reads this turn will be pinned to. Non-fatal: a null SHA
    // leaves the link working — the tools read by branch name regardless — and
    // only costs a captured migration source its exact revision.
    const sha = await getBranchHead(token, {
      repoFullName: repository.fullName,
      branch,
    }).catch(() => null);

    return {
      appRepo: {
        fullName: repository.fullName,
        branch,
        sha,
        token,
      },
      problem: null,
    };
  } catch (error) {
    const problem =
      error instanceof GithubRequestError && error.status === 404
        ? "GitHub reports it does not exist, which usually means it was renamed or the access this installation was granted no longer covers it."
        : error instanceof GithubRequestError &&
            (error.status === 401 || error.status === 403)
          ? "GitHub refused the request, so the access this installation was granted needs checking."
          : "GitHub could not be reached for it.";

    // Not fatal. A project's own work does not depend on the application being
    // readable, and a turn that refused to run would be a worse answer than one
    // that says the link is broken.
    return { appRepo: null, problem };
  }
}

async function readLastCheck(
  token: string,
  repoFullName: string,
  branch: string,
): Promise<AgentPipelineCheck | null> {
  try {
    const runs = await listWorkflowRuns(token, { repoFullName, perPage: 20 });
    const run = runs.find((entry) => entry.headBranch === branch);
    if (!run) return null;

    return {
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      htmlUrl: run.htmlUrl,
      createdAt: run.createdAt,
    };
  } catch {
    return null;
  }
}

export async function GET(
  _req: Request,
  { params }: { params: { projectId: string } },
) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const project = await findOwnedProject(userId, params.projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const messages = await database.projectChatMessage.findMany({
    where: { projectId: project.id },
    ...HISTORY_QUERY,
  });

  return NextResponse.json({
    messages: messages.reverse().map(toChatMessageDto),
  });
}

/**
 * One chat turn.
 *
 * The user's message is stored before the agent runs so a failure mid-turn
 * still leaves a readable transcript. Any mutations the agent returns go
 * through the same commit path as manual canvas edits, and the resulting graph
 * comes back with the reply so the canvas can refresh without a second round
 * trip.
 */
export async function POST(
  req: Request,
  { params }: { params: { projectId: string } },
) {
  // The agent budget, not the ordinary write budget. Each turn forks a ~190 MB
  // Copilot CLI child and may hold the request for five minutes, so without a
  // ceiling one account can exhaust the host's memory — the container has no
  // resource limit that would stop it before the OOM killer does.
  let userId: string;
  try {
    userId = await requireUserWithLimit("agent.turn", RATE_LIMITS.agentTurn);
  } catch (e) {
    return routeError("chat", e);
  }

  const project = await findOwnedProject(userId, params.projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // The message is capped because it is persisted and then spent on the model: there
  // was no limit at all, so a multi-megabyte message became a multi-megabyte row and a
  // prompt the user pays for. `model` and `reasoningEffort` stay `unknown` — the
  // helpers below check them against the entitled catalogue, which is a stronger check
  // than a shape.
  let body: {
    message: string;
    model?: unknown;
    reasoningEffort?: unknown;
  };
  try {
    body = await parseJsonBody(
      req,
      z.object({
        message: z
          .string()
          .trim()
          .min(1, "Message is empty")
          .max(
            MAX_MESSAGE_CHARS,
            `A message may be at most ${MAX_MESSAGE_CHARS} characters.`,
          ),
        model: z.unknown().optional(),
        reasoningEffort: z.unknown().optional(),
      }),
    );
  } catch (e) {
    return routeError("chat", e);
  }

  const message = body.message;
  const totalStartedMs = performance.now();
  let latestTelemetry: AgentTurnTelemetry | null = null;
  let resolvedModel: string | null = null;
  let resolvedReasoningEffort: ReasoningEffortValue | null = null;

  const withTotalDuration = (
    telemetry: AgentTurnTelemetry | null,
  ): AgentTurnTelemetry | null =>
    telemetry
      ? {
          ...telemetry,
          totalDurationMs: Math.round(performance.now() - totalStartedMs),
        }
      : null;

  /** Prisma JSON after removing any SDK-side `undefined` fields. */
  const metadataJson = (value: unknown): Prisma.InputJsonValue =>
    JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

  const token = await getProviderTokenForRequest(req, project.provider);
  if (!token) {
    return NextResponse.json(
      { error: "GitHub is not connected" },
      { status: 401 },
    );
  }

  // The agent bills the person, not the app, so the Copilot session runs on the
  // signed-in user's own token.
  const copilotToken = await getUserGithubToken();
  if (!copilotToken) {
    return NextResponse.json(
      { error: "Link your GitHub account to use the agent" },
      { status: 401 },
    );
  }

  const userMessage = await database.projectChatMessage.create({
    data: { projectId: project.id, role: "user", content: message },
  });

  // Mark the project so the chat panel can show a spinner even after a
  // navigation away and back. Cleared in the finally below.
  await database.project.update({
    where: { id: project.id },
    data: { agentRunning: true, agentSteps: [] },
  });

  /**
   * Publishes the turn's progress for `chat/status` to read.
   *
   * Throttled, and deliberately not awaited: the write is bookkeeping for the UI,
   * so it must never slow the turn down or fail it. `flushing` keeps a slow write
   * from being overtaken by the next one, which would otherwise let an older
   * trail land last and appear to lose steps.
   */
  let lastFlush = 0;
  let flushing = false;
  const publishProgress = (steps: AgentStep[]) => {
    const now = Date.now();
    if (flushing || now - lastFlush < AGENT_PROGRESS_INTERVAL_MS) return;

    lastFlush = now;
    flushing = true;
    // Copied because the agent keeps appending to the live array while this
    // write is in flight.
    const snapshot = [...steps];

    void database.project
      .update({
        where: { id: project.id },
        data: { agentSteps: snapshot as unknown as Prisma.InputJsonValue },
      })
      .catch(() => {})
      .finally(() => {
        flushing = false;
      });
  };

  /**
   * Watches for someone asking this turn to stop.
   *
   * The signal is `agentRunning` going false while we are still running, because we
   * are the only writer that sets it true and we do not clear it until the finally
   * below. That makes a stop a single-column write from any process, which matters:
   * the request that presses Stop is not this request, and on more than one instance
   * it is not even this process, so an in-memory flag could not be reached.
   *
   * Deliberately not a new column. A second flag would have to be kept consistent
   * with this one, and the two could then disagree about whether a turn is running.
   */
  const cancellation = new AbortController();
  const stopWatch = setInterval(() => {
    void database.project
      .findUnique({
        where: { id: project.id },
        select: { agentRunning: true },
      })
      .then((row) => {
        if (row && !row.agentRunning) cancellation.abort();
      })
      .catch(() => {});
  }, AGENT_CANCEL_POLL_MS);

  try {
    const [
      graph,
      library,
      history,
      settings,
      mcpServers,
      curation,
      lastCheck,
      application,
      decisions,
    ] = await Promise.all([
      loadProjectGraph(token, project),
      readModuleLibrary(userId),
      database.projectChatMessage
        .findMany({ where: { projectId: project.id }, ...HISTORY_QUERY })
        .then((rows) => rows.reverse()),
      getEffectiveAgentSettings(userId, project.id),
      mcpServersForSession(userId),
      getHarnessCuration(userId),
      readLastCheck(token, project.repoFullName, project.repoBranch),
      resolveAppRepo(token, project),
      activeDecisions(project.id),
    ]);

    // The pipeline's verdict on the previous turn is now a fact — `readLastCheck`
    // just read it — so the transformation that turn recorded can be labelled with
    // it. Fire-and-forget: it is bookkeeping on an earlier turn and must not hold
    // up this one. Runs regardless of what the agent is allowed to see, because the
    // label is about the commit, not about what the model was shown.
    void backfillPipelineOutcome(project.id, lastCheck);

    // Knowledge is withheld by not assembling it, not by asking the model to
    // ignore it. `graph` below is still the real one — it goes back to the
    // client to refresh the canvas, and mutations commit against the repository
    // regardless of what the agent was allowed to read.
    const seesRepo = knowledgeEnabled(
      settings.disabledKnowledge,
      KNOWLEDGE_PROJECT_REPO,
    );
    const seesLibrary = knowledgeEnabled(
      settings.disabledKnowledge,
      KNOWLEDGE_MODULE_LIBRARY,
    );

    // The composer's pick, else the project's stored one, checked against the
    // user's Copilot list: a model that has left it would fail the session, so
    // the turn runs on the newest Anthropic model instead. The settings screen
    // and the composer read the same answer and show it before the turn.
    const modelChoice = await resolveCopilotModel(
      copilotToken,
      requestedModel(body?.model) ?? settings.model,
    );
    resolvedModel = modelChoice.model;
    resolvedReasoningEffort = resolveEffort(body?.reasoningEffort);

    const turn = await runProjectAgent(message, {
      projectName: project.name,
      repoFullName: project.repoFullName,
      branch: project.repoBranch,
      // Resolved and confirmed above, and carrying the provider token it was
      // verified with. Null when the link is broken — `appRepoProblem` then says
      // so, which is a different statement from having no link at all.
      appRepo: application.appRepo,
      appRepoLink: project.appRepoFullName
        ? { fullName: project.appRepoFullName }
        : null,
      appRepoProblem: application.problem,
      graph: seesRepo ? graph : blindGraph(graph.sha),
      userId,
      projectId: project.id,
      githubToken: copilotToken,
      instructions: settings.instructions,
      disabledKnowledge: settings.disabledKnowledge,
      mcpServers,
      model: resolvedModel,
      reasoningEffort: resolvedReasoningEffort,
      disabledTools: settings.disabledTools,
      turnTimeout: settings.turnTimeout,
      maxToolCalls: settings.maxToolCalls,
      maxMcpCalls: settings.maxMcpCalls,
      historyBudgetChars: settings.historyBudgetChars,
      maxSteps: settings.maxSteps,
      maxAppRepoReads: settings.maxAppRepoReads,
      appRepoTreeLimit: settings.appRepoTreeLimit,
      appRepoFileChars: settings.appRepoFileChars,
      allowDestructive: settings.allowDestructive,
      // Curated in the admin panel, defaults in code. Read per turn rather than
      // cached, so an edit takes effect on the next message instead of on the
      // next deploy — which is the entire point of making it editable.
      //
      // Rendered here rather than in the curation store, because the number a
      // rule quotes is this user's budget: the store serves the admin screen,
      // which edits the text for everyone and knows nobody's settings.
      operatingRules: curation.operatingRulesRaw.map((rule) =>
        renderOperatingRule(
          rule,
          settings.maxToolCalls ?? AGENT_MAX_TOOL_CALLS,
        ),
      ),
      toolDescriptions: Object.fromEntries(
        curation.operations.map((operation) => [
          operation.name,
          operation.description,
        ]),
      ),
      onStep: publishProgress,
      onTelemetry: (telemetry) => {
        latestTelemetry = telemetry;
      },
      signal: cancellation.signal,
      // The whole module rather than a three-field summary. The ports were always
      // loaded here and thrown away one line before the prompt, which left the
      // agent able to place a module and unable to wire it. The prompt still only
      // renders a line per module — see `summariseLibraryModule`.
      library: seesLibrary ? toAgentLibrary(library) : [],
      // Looked up per call, for the two or three modules a turn asks about. Folding
      // resources into the library read would multiply the cost of every graph load
      // to answer a question only the agent asks.
      moduleResources: (moduleIds) =>
        readModuleResourceTypes(userId, moduleIds),
      // Withheld with the repository: the run's verdict is a statement about the
      // Terraform on the branch, which is the thing being withheld.
      lastCheck: seesRepo ? lastCheck : null,
      history: history.map((entry) => ({
        role: entry.role,
        content: entry.content,
      })),
      // Withheld with the repository: a decision is a statement about the
      // Terraform, and describing it to an agent that cannot see the project
      // would be telling it what was built without letting it look.
      decisions: seesRepo
        ? decisions.map((decision) => ({
            id: decision.id,
            question: decision.question,
            choice: decision.choice,
            reason: decision.reason,
            rejected: decision.alternatives.map(
              (entry) => `${entry.option} (${entry.reason})`,
            ),
          }))
        : [],
    });
    latestTelemetry = turn.telemetry;

    let currentGraph: ProjectGraph = graph;
    const commits: string[] = [];
    const mutationErrors: string[] = [];

    /**
     * The assistant message, created before the edits rather than after.
     *
     * Every operation of a turn points at it, so it has to exist before the first
     * one is written. Created here and not earlier: the turn has already produced
     * its reply, so there is never a moment when the transcript holds an empty
     * assistant bubble.
     */
    const assistantMessage = await database.projectChatMessage.create({
      data: {
        projectId: project.id,
        role: "assistant",
        content: turn.reply,
        metadata: metadataJson({
          mutations: turn.mutations.length,
          model: resolvedModel,
          reasoningEffort: resolvedReasoningEffort,
          outcome: "completed",
          telemetry: withTotalDuration(turn.telemetry),
        }),
      },
    });

    /**
     * The decisions this turn recorded, written before the edits they explain.
     *
     * Ids in queue order, so `decisionFor` below can name the one in force when a
     * given mutation was queued.
     */
    const decisionIds: string[] = [];
    for (const decision of turn.decisions) {
      try {
        decisionIds.push(
          await recordDecision(project.id, "agent", {
            question: decision.question,
            context: decision.context,
            choice: decision.choice,
            reason: decision.reason,
            alternatives: decision.alternatives,
            plan: decision.plan,
            ...(decision.supersedes ? { supersedes: decision.supersedes } : {}),
          }),
        );
      } catch {
        // A decision that cannot be written must not cost the edits it explains.
        decisionIds.push("");
      }
    }

    /** The decision in force when mutation `index` was queued, if any. */
    const decisionFor = (index: number): string | undefined => {
      for (let i = turn.decisions.length - 1; i >= 0; i--) {
        const decision = turn.decisions[i];
        if (decision && decision.fromMutation <= index) {
          return decisionIds[i] || undefined;
        }
      }
      return undefined;
    };

    for (const [index, mutation] of turn.mutations.entries()) {
      try {
        const decisionId = decisionFor(index);
        const result = await applyProjectMutation(token, project, mutation, {
          origin: "agent",
          chatMessageId: assistantMessage.id,
          ...(decisionId ? { decisionId } : {}),
        });
        currentGraph = result.graph;
        if (result.commit) commits.push(result.commit.sha);
      } catch (mutationErr) {
        // A single failed mutation (e.g. a name collision the tool validation
        // missed) must not abort the whole turn. The user sees the error in the
        // steps, and the mutations that did succeed stay committed.
        const msg =
          mutationErr instanceof Error
            ? mutationErr.message
            : "Unknown mutation error";
        mutationErrors.push(msg);
      }
    }

    // The commit closes the trail: the reasoning above explains the intent, this
    // is the proof it reached the repository the graph is rebuilt from. The same
    // tail is appended to both trails — the capped one the UI stores and the full
    // one the training record keeps — so neither ends before the commit it
    // describes.
    const trailTail: AgentStep[] = [
      ...(commits.length
        ? [
            {
              kind: "tool" as const,
              tool: "commit",
              summary: `Pushed ${commits.length} commit${commits.length === 1 ? "" : "s"} to ${project.repoFullName}@${project.repoBranch}`,
              ok: true,
            },
          ]
        : []),
      ...mutationErrors.map((msg) => ({
        kind: "tool" as const,
        tool: "mutation",
        summary: msg,
        ok: false,
      })),
    ];
    const steps: AgentStep[] = [...turn.steps, ...trailTail];
    const fullSteps: AgentStep[] = [...turn.fullSteps, ...trailTail];

    // The row already exists — the operations point at it — so this fills in what
    // only the commit loop could know.
    const completed = await database.projectChatMessage.update({
      where: { id: assistantMessage.id },
      data: {
        metadata: metadataJson({
          commits,
          mutations: turn.mutations.length,
          decisions: decisionIds.filter(Boolean),
          steps,
          model: resolvedModel,
          reasoningEffort: resolvedReasoningEffort,
          // A mutation that threw is still a completed turn with a reported
          // failure in its trail, not an `error` turn — that word is reserved for
          // a turn that never produced a reply at all.
          outcome: "completed",
          telemetry: withTotalDuration(turn.telemetry),
        }),
      },
    });

    // The whole turn, captured as one record for the harness: the prompt and the
    // conditions it ran under, the graph before (`graph`) and after
    // (`currentGraph`), the trajectory, mutations and decisions in between, and the
    // commits it produced. Fire-and-forget and self-skipping — it writes nothing
    // for a turn that only answered — so a pure question costs no row and a failed
    // write never costs the reply. The pipeline verdict is filled in by a later
    // turn's `backfillPipelineOutcome`.
    void recordTransformation({
      projectId: project.id,
      userId,
      chatMessageId: assistantMessage.id,
      prompt: message,
      reply: turn.reply,
      settings: {
        model: resolvedModel ?? modelChoice.model,
        reasoningEffort: resolvedReasoningEffort,
        maxToolCalls: settings.maxToolCalls ?? null,
        maxSteps: settings.maxSteps ?? null,
        allowDestructive: settings.allowDestructive ?? null,
        disabledTools: settings.disabledTools ?? [],
        disabledKnowledge: settings.disabledKnowledge ?? [],
        seesRepo,
        seesLibrary,
      },
      graphBefore: graph,
      graphAfter: currentGraph,
      // The full, untrimmed trail for training; the UI trail (`steps`) is stored
      // on the assistant message above.
      steps: fullSteps,
      mutations: turn.mutations,
      decisions: turn.decisions,
      commits,
      mutationErrors,
      outcome: "completed",
      // What the turn read beyond the graph — app-repo files, MCP results —
      // collected inside the tools because the step trail only summarises it. This
      // is the legacy/on-prem starting state a migration transforms from.
      migrationSource: turn.migrationSource,
      // Pinned to the revision the reads came from. `application.appRepo` carries
      // the token too, which has no place in a record, so only identity is passed.
      appRepo: application.appRepo
        ? {
            fullName: application.appRepo.fullName,
            branch: application.appRepo.branch,
            sha: application.appRepo.sha,
          }
        : null,
    });

    return NextResponse.json({
      messages: [userMessage, completed].map(toChatMessageDto),
      graph: currentGraph,
      changed: commits.length > 0,
    });
  } catch (e) {
    /**
     * A stop is an outcome, not an error, so it gets its own message and a 200.
     *
     * Nothing is committed, and that is not a compromise — the tools queue edits
     * and the loop above is the only thing that applies them, so a turn that never
     * reaches it has not touched the repository. Said out loud in the transcript,
     * because "stopped" without that sentence leaves the reader wondering what got
     * half-built.
     */
    if (e instanceof TurnCancelled) {
      const stopped = await database.projectChatMessage.create({
        data: {
          projectId: project.id,
          role: "system",
          content:
            "Stopped. Nothing was committed — the agent's edits are only written to the repository once a turn finishes.",
          metadata: metadataJson({
            stopped: true,
            outcome: "stopped",
            model: resolvedModel,
            reasoningEffort: resolvedReasoningEffort,
            telemetry: withTotalDuration(latestTelemetry),
          }),
        },
      });

      // No `graph`: nothing was committed, so the canvas on screen is still
      // correct and refreshing it would only make it flicker.
      return NextResponse.json({
        messages: [userMessage, stopped].map(toChatMessageDto),
        changed: false,
      });
    }

    const reason =
      e instanceof Error ? e.message : "The agent could not complete the turn";

    const assistantMessage = await database.projectChatMessage.create({
      data: {
        projectId: project.id,
        role: "system",
        content: reason,
        metadata: metadataJson({
          error: true,
          outcome: "error",
          model: resolvedModel,
          reasoningEffort: resolvedReasoningEffort,
          telemetry: withTotalDuration(latestTelemetry),
        }),
      },
    });

    const status =
      e instanceof MutationError
        ? 409
        : e instanceof GithubRequestError
          ? e.status
          : 500;

    return NextResponse.json(
      {
        error: reason,
        messages: [userMessage, assistantMessage].map(toChatMessageDto),
      },
      { status },
    );
  } finally {
    clearInterval(stopWatch);
    // The trail is cleared with the flag: from here on the steps live on the
    // assistant message, and leaving a copy here would make the next turn open
    // with the previous one's progress still on screen.
    await database.project
      .update({
        where: { id: project.id },
        data: { agentRunning: false, agentSteps: Prisma.DbNull },
      })
      .catch(() => {});
  }
}
