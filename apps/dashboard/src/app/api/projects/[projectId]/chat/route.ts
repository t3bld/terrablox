import { NextResponse } from "next/server";

import { COPILOT_MODEL, COPILOT_REASONING_EFFORT } from "@/lib/agent/copilot";
import { getEffectiveAgentSettings } from "@/lib/agent/effective-settings";
import { runProjectAgent } from "@/lib/agent/project-agent";
import {
  mcpServersForSession,
  REASONING_EFFORTS,
  type ReasoningEffortValue,
} from "@/lib/agent/settings-service";
import { resolveSkills } from "@/lib/agent/skills";
import {
  getCurrentUserId,
  getProviderTokenForRequest,
  getUserGithubToken,
} from "@/lib/auth/server-helpers";
import { database } from "@/lib/database";
import { GithubRequestError } from "@/lib/github/repo-files";
import { toChatMessageDto } from "@/lib/projects/serialize";
import {
  applyProjectMutation,
  findOwnedProject,
  loadProjectGraph,
  MutationError,
  readModuleLibrary,
} from "@/lib/projects/service";
import type { AgentStep, ProjectGraph } from "@/lib/projects/types";

const HISTORY_LIMIT = 50;

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
    orderBy: { createdAt: "asc" },
    take: HISTORY_LIMIT,
  });

  return NextResponse.json({ messages: messages.map(toChatMessageDto) });
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

  try {
    const [graph, library, history, settings, mcpServers] = await Promise.all([
      loadProjectGraph(token, project),
      readModuleLibrary(userId),
      database.projectChatMessage.findMany({
        where: { projectId: project.id },
        orderBy: { createdAt: "asc" },
        take: HISTORY_LIMIT,
      }),
      getEffectiveAgentSettings(userId, project.id),
      mcpServersForSession(userId),
    ]);

    const turn = await runProjectAgent(message, {
      projectName: project.name,
      repoFullName: project.repoFullName,
      branch: project.repoBranch,
      graph,
      userId,
      projectId: project.id,
      githubToken: copilotToken,
      instructions: settings.instructions,
      skills: resolveSkills(settings.skills),
      mcpServers,
      model: resolveModel(body?.model),
      reasoningEffort: resolveEffort(body?.reasoningEffort),
      disabledTools: settings.disabledTools,
      library: library.map((mod) => ({
        id: mod.id,
        name: mod.sourceName ?? mod.id,
        versionTag: mod.versionTag,
      })),
      history: history.map((entry) => ({
        role: entry.role,
        content: entry.content,
      })),
    });

    let currentGraph: ProjectGraph = graph;
    const commits: string[] = [];

    for (const mutation of turn.mutations) {
      const result = await applyProjectMutation(
        token,
        project,
        mutation,
        "agent",
      );
      currentGraph = result.graph;
      if (result.commit) commits.push(result.commit.sha);
    }

    // The commit closes the trail: the reasoning above explains the intent, this
    // is the proof it reached the repository the graph is rebuilt from.
    const steps: AgentStep[] = commits.length
      ? [
          ...turn.steps,
          {
            kind: "tool",
            tool: "commit",
            summary: `Pushed ${commits.length} commit${commits.length === 1 ? "" : "s"} to ${project.repoFullName}@${project.repoBranch}`,
            ok: true,
          },
        ]
      : turn.steps;

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
  }
}
