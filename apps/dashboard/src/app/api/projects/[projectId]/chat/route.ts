import { NextResponse } from "next/server";

import { runProjectAgent } from "@/lib/agent/project-agent";
import {
  getAgentSettings,
  mcpServersForSession,
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
import type { ProjectGraph } from "@/lib/projects/types";

const HISTORY_LIMIT = 50;

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
      getAgentSettings(userId),
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
      const result = await applyProjectMutation(token, project, mutation);
      currentGraph = result.graph;
      if (result.commit) commits.push(result.commit.sha);
    }

    const assistantMessage = await database.projectChatMessage.create({
      data: {
        projectId: project.id,
        role: "assistant",
        content: turn.reply,
        metadata: { commits, mutations: turn.mutations.length },
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
