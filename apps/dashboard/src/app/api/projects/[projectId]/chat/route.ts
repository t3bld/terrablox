import { NextResponse } from "next/server";

/**
 * The agent loop may run for minutes on complex tasks (many tool calls), so the
 * route must not time out before the SDK does. This only matters when deployed on
 * platforms with a per-route timeout (Vercel, Netlify); locally Next.js has none.
 */
export const maxDuration = 300; // seconds — matches SEND_AND_WAIT_TIMEOUT_MS

import { Prisma } from "@terrablox/database";
import { COPILOT_MODEL, COPILOT_REASONING_EFFORT } from "@/lib/agent/copilot";
import { getEffectiveAgentSettings } from "@/lib/agent/effective-settings";
import { getHarnessCuration } from "@/lib/agent/harness-curation";
import {
  KNOWLEDGE_MODULE_LIBRARY,
  KNOWLEDGE_PROJECT_REPO,
  knowledgeEnabled,
} from "@/lib/agent/knowledge";
import { toAgentLibrary } from "@/lib/agent/library-view";
import {
  type AgentPipelineCheck,
  runProjectAgent,
} from "@/lib/agent/project-agent";
import { AGENT_PROGRESS_INTERVAL_MS } from "@/lib/agent/runtime-options";
import {
  mcpServersForSession,
  REASONING_EFFORTS,
  type ReasoningEffortValue,
} from "@/lib/agent/settings-service";
import {
  getCurrentUserId,
  getProviderTokenForRequest,
  getUserGithubToken,
} from "@/lib/auth/server-helpers";
import { database } from "@/lib/database";
import { GithubRequestError, listWorkflowRuns } from "@/lib/github/repo-files";
import { toChatMessageDto } from "@/lib/projects/serialize";
import {
  applyProjectMutation,
  findOwnedProject,
  loadProjectGraph,
  MutationError,
  readModuleLibrary,
  readModuleResourceTypes,
} from "@/lib/projects/service";
import type { AgentStep, ProjectGraph } from "@/lib/projects/types";

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

/** Newest first from the database, then flipped back into reading order. */
const HISTORY_QUERY = {
  orderBy: { createdAt: "desc" },
  take: HISTORY_LIMIT,
} as const;

/**
 * The composer sends the model and effort with every turn, so nothing here is
 * trusted: an unknown id would fail the session with a runtime error instead of
 * a message the user can act on.
 */
function resolveModel(value: unknown): string {
  return typeof value === "string" && /^[\w.:-]{1,100}$/.test(value)
    ? value
    : COPILOT_MODEL;
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
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const project = await findOwnedProject(userId, params.projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const body = (await req.json().catch(() => null)) as {
    message?: string;
    model?: unknown;
    reasoningEffort?: unknown;
  } | null;
  const message = body?.message?.trim();
  if (!message) {
    return NextResponse.json({ error: "Message is empty" }, { status: 400 });
  }

  const token = await getProviderTokenForRequest(req, project.provider);
  if (!token) {
    return NextResponse.json(
      { error: "GitHub is not connected" },
      { status: 401 },
    );
  }

  // The agent bills the person, not the app, so it needs a user token even
  // when repository writes go through a GitHub App installation.
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

  try {
    const [graph, library, history, settings, mcpServers, curation, lastCheck] =
      await Promise.all([
        loadProjectGraph(token, project),
        readModuleLibrary(userId),
        database.projectChatMessage
          .findMany({ where: { projectId: project.id }, ...HISTORY_QUERY })
          .then((rows) => rows.reverse()),
        getEffectiveAgentSettings(userId, project.id),
        mcpServersForSession(userId),
        getHarnessCuration(),
        readLastCheck(token, project.repoFullName, project.repoBranch),
      ]);

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

    const turn = await runProjectAgent(message, {
      projectName: project.name,
      repoFullName: project.repoFullName,
      branch: project.repoBranch,
      // Read with the user's own token rather than the installation one: the
      // application repository was picked from what that account can see, and an
      // App installation is scoped to the repositories it was installed on —
      // which need not include this one. The branch falls back to `main` only as
      // a last resort; the picker stores what GitHub reported as default.
      appRepo: project.appRepoFullName
        ? {
            fullName: project.appRepoFullName,
            branch: project.appRepoBranch ?? "main",
          }
        : null,
      graph: seesRepo ? graph : blindGraph(graph.sha),
      userId,
      projectId: project.id,
      githubToken: copilotToken,
      instructions: settings.instructions,
      disabledKnowledge: settings.disabledKnowledge,
      mcpServers,
      model: resolveModel(body?.model),
      reasoningEffort: resolveEffort(body?.reasoningEffort),
      disabledTools: settings.disabledTools,
      turnTimeout: settings.turnTimeout,
      allowDestructive: settings.allowDestructive,
      // Curated in the admin panel, defaults in code. Read per turn rather than
      // cached, so an edit takes effect on the next message instead of on the
      // next deploy — which is the entire point of making it editable.
      operatingRules: curation.operatingRules,
      toolDescriptions: Object.fromEntries(
        curation.operations.map((operation) => [
          operation.name,
          operation.description,
        ]),
      ),
      onStep: publishProgress,
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
    });

    let currentGraph: ProjectGraph = graph;
    const commits: string[] = [];
    const mutationErrors: string[] = [];

    for (const mutation of turn.mutations) {
      try {
        const result = await applyProjectMutation(
          token,
          project,
          mutation,
          "agent",
        );
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
    // is the proof it reached the repository the graph is rebuilt from.
    const steps: AgentStep[] = [
      ...turn.steps,
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

    const assistantMessage = await database.projectChatMessage.create({
      data: {
        projectId: project.id,
        role: "assistant",
        content: turn.reply,
        metadata: { commits, mutations: turn.mutations.length, steps },
      },
    });

    return NextResponse.json({
      messages: [userMessage, assistantMessage].map(toChatMessageDto),
      graph: currentGraph,
      changed: commits.length > 0,
    });
  } catch (e) {
    const reason =
      e instanceof Error ? e.message : "The agent could not complete the turn";

    const assistantMessage = await database.projectChatMessage.create({
      data: {
        projectId: project.id,
        role: "system",
        content: reason,
        metadata: { error: true },
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
