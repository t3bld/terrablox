import { NextResponse } from "next/server";

import { COPILOT_MODEL, COPILOT_REASONING_EFFORT } from "@/lib/agent/copilot";
import { getAgentSettings } from "@/lib/agent/settings-service";
import { AGENT_SKILLS } from "@/lib/agent/skills";
import { PROJECT_AGENT_TOOLS } from "@/lib/agent/tool-catalogue";
import {
  getCurrentUserId,
  getUserGithubToken,
} from "@/lib/auth/server-helpers";
import { database } from "@/lib/database";

/**
 * What the project agent can draw on, read from the same places a turn reads.
 *
 * The point of the view is trust, so it must not be assembled from a parallel
 * description of the agent that could drift: the skills, servers and tools here
 * are the very lists the prompt and the session are built from.
 */
export async function GET() {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [settings, moduleCount, projectCount, githubToken] = await Promise.all([
    getAgentSettings(userId),
    database.terraformModule.count({ where: { userId } }),
    database.project.count({ where: { userId } }),
    getUserGithubToken(),
  ]);

  return NextResponse.json({
    // The chat composer picks per turn; these are what it starts from.
    model: COPILOT_MODEL,
    reasoningEffort: COPILOT_REASONING_EFFORT,
    // The agent runs on the user's own Copilot seat, so no token means no turn.
    githubConnected: Boolean(githubToken),
    instructionsLength: settings.instructions.trim().length,
    skills: AGENT_SKILLS.map(({ id, name, description }) => ({
      id,
      name,
      description,
      enabled: settings.skills.includes(id),
    })),
    mcpServers: settings.mcpServers.map(({ id, name, url, enabled }) => ({
      id,
      name,
      url,
      enabled,
    })),
    moduleCount,
    projectCount,
    tools: PROJECT_AGENT_TOOLS.map(({ name, label, summary }) => ({
      name,
      label,
      summary,
      enabled: !settings.disabledTools.includes(name),
    })),
  });
}
