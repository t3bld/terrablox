import { NextResponse } from "next/server";

import { COPILOT_MODEL, COPILOT_REASONING_EFFORT } from "@/lib/agent/copilot";
import {
  type AgentOverrides,
  getEffectiveAgentSettings,
  parseOverrides,
} from "@/lib/agent/effective-settings";
import { AGENT_KNOWLEDGE, knowledgeEnabled } from "@/lib/agent/knowledge";
import { DEFAULT_TURN_TIMEOUT_SECONDS } from "@/lib/agent/runtime-options";
import { getAgentSettings } from "@/lib/agent/settings-service";
import { PROJECT_AGENT_TOOLS } from "@/lib/agent/tool-catalogue";
import {
  getCurrentUserId,
  getUserGithubToken,
} from "@/lib/auth/server-helpers";
import { database } from "@/lib/database";
import { visibleToUser } from "@/lib/modules/ownership";

/**
 * What the project agent can draw on, read from the same places a turn reads.
 *
 * The point of the view is trust, so it must not be assembled from a parallel
 * description of the agent that could drift: the knowledge, tools and limits here
 * are the very lists the prompt and the session are built from.
 *
 * With `?projectId=` it answers for one project — the global settings narrowed by
 * whatever that project overrides — and reports which fields the project decides
 * itself. Without it, it answers for the defaults every new project inherits.
 */
export async function GET(request: Request) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const projectId = new URL(request.url).searchParams.get("projectId")?.trim();

  if (projectId) {
    // Checked before reading settings so an id belonging to someone else is a
    // 404 rather than a view of this user's defaults under a foreign project.
    const project = await database.project.findFirst({
      where: { id: projectId, userId },
      select: {
        agentOverrides: true,
        appRepoFullName: true,
        appRepoBranch: true,
      },
    });

    if (!project) {
      return NextResponse.json(
        { error: "Project not found." },
        { status: 404 },
      );
    }

    const [settings, moduleCount, projectCount, githubToken] =
      await Promise.all([
        getEffectiveAgentSettings(userId, projectId),
        database.terraformModule.count({ where: visibleToUser(userId) }),
        database.project.count({ where: { userId } }),
        getUserGithubToken(),
      ]);

    return NextResponse.json(
      view({
        settings,
        moduleCount,
        projectCount,
        githubConnected: Boolean(githubToken),
        scope: "project",
        overrides: parseOverrides(project.agentOverrides),
        overridden: settings.overridden,
        appRepo: project.appRepoFullName
          ? {
              fullName: project.appRepoFullName,
              branch: project.appRepoBranch,
            }
          : null,
      }),
    );
  }

  const [settings, moduleCount, projectCount, githubToken] = await Promise.all([
    getAgentSettings(userId),
    database.terraformModule.count({ where: visibleToUser(userId) }),
    database.project.count({ where: { userId } }),
    getUserGithubToken(),
  ]);

  return NextResponse.json(
    view({
      settings,
      moduleCount,
      projectCount,
      githubConnected: Boolean(githubToken),
      scope: "global",
      overrides: {},
      overridden: [],
      // A link belongs to one project, so the defaults view has none to report.
      appRepo: null,
    }),
  );
}

/** One shape for both scopes, so the client renders one view either way. */
function view(input: {
  settings: {
    instructions: string;
    model: string | null;
    reasoningEffort: string | null;
    turnTimeout: number | null;
    disabledKnowledge: string[];
    disabledTools: string[];
    allowDestructive: boolean;
  };
  moduleCount: number;
  projectCount: number;
  githubConnected: boolean;
  scope: "global" | "project";
  /** Echoed back to the client untouched; only the project scope has any. */
  overrides: AgentOverrides;
  overridden: string[];
  /** The linked application repository, in the project scope only. */
  appRepo: { fullName: string; branch: string | null } | null;
}) {
  const { settings } = input;

  return {
    scope: input.scope,
    /** The keys this project decides itself; empty in the global scope. */
    overridden: input.overridden,
    /** Sent back verbatim on save, because a PUT replaces the whole object. */
    overrides: input.overrides,
    // The stored choice, which is null when none was made. Sent alongside the
    // fallbacks rather than already resolved: the settings screen has to show what
    // "no choice" resolves to without claiming somebody chose it.
    model: settings.model,
    reasoningEffort: settings.reasoningEffort,
    turnTimeout: settings.turnTimeout,
    // Not a deny list like the other two permissions, so it is reported as the
    // plain answer it is: may the agent delete here, yes or no.
    allowDestructive: settings.allowDestructive,
    defaults: {
      model: COPILOT_MODEL,
      reasoningEffort: COPILOT_REASONING_EFFORT,
      turnTimeout: DEFAULT_TURN_TIMEOUT_SECONDS,
    },
    // The agent runs on the user's own Copilot seat, so no token means no turn.
    githubConnected: input.githubConnected,
    // Reported next to the knowledge sources it belongs to, because switching the
    // source off and having nothing linked look identical from the prompt and are
    // fixed on two different screens.
    appRepo: input.appRepo,
    // Instructions are global by design: they are the user's standing
    // preferences, not a property of one project.
    instructions: settings.instructions,
    instructionsLength: settings.instructions.trim().length,
    knowledge: AGENT_KNOWLEDGE.map(({ id, name, description }) => ({
      id,
      name,
      description,
      enabled: knowledgeEnabled(settings.disabledKnowledge, id),
    })),
    // No `mcpServers`: outside tool providers are not part of the MVP, so the
    // settings screen offers no way to add or enable one. The storage and the
    // session wiring are untouched, so putting the section back is a UI change.
    moduleCount: input.moduleCount,
    projectCount: input.projectCount,
    tools: PROJECT_AGENT_TOOLS.map(({ name, group, label, summary }) => ({
      name,
      group,
      label,
      summary,
      enabled: !settings.disabledTools.includes(name),
    })),
  };
}
