import { NextResponse } from "next/server";

import {
  type AgentOverrides,
  getEffectiveAgentSettings,
  parseOverrides,
  saveAgentOverrides,
} from "@/lib/agent/effective-settings";
import { getAgentSettings } from "@/lib/agent/settings-service";
import { AGENT_SKILLS } from "@/lib/agent/skills";
import { PROJECT_AGENT_TOOLS } from "@/lib/agent/tool-catalogue";
import { getCurrentUserId } from "@/lib/auth/server-helpers";
import { database } from "@/lib/database";

/**
 * Agent settings for one project.
 *
 * Returns the global values alongside the effective ones so the UI can show
 * what "inherit" currently resolves to, rather than an empty field the user has
 * to guess about.
 */
export async function GET(
  _request: Request,
  { params }: { params: { projectId: string } },
) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const project = await database.project.findFirst({
    where: { id: params.projectId, userId },
    select: { agentOverrides: true },
  });

  if (!project) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }

  const [global, effective] = await Promise.all([
    getAgentSettings(userId),
    getEffectiveAgentSettings(userId, params.projectId),
  ]);

  return NextResponse.json({
    overrides: parseOverrides(project.agentOverrides),
    effective,
    global: {
      model: global.model,
      reasoningEffort: global.reasoningEffort,
      skills: global.skills,
      disabledTools: global.disabledTools,
    },
    catalogue: {
      skills: AGENT_SKILLS.map(({ id, name, description }) => ({
        id,
        name,
        description,
      })),
      tools: PROJECT_AGENT_TOOLS.map(({ name, label, summary }) => ({
        name,
        label,
        summary,
      })),
    },
  });
}

export async function PUT(
  request: Request,
  { params }: { params: { projectId: string } },
) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: AgentOverrides;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
  }

  try {
    await saveAgentOverrides(userId, params.projectId, body);
    return NextResponse.json({
      overrides: parseOverrides(body),
      effective: await getEffectiveAgentSettings(userId, params.projectId),
    });
  } catch (error) {
    console.error("[agent] failed to save project overrides", error);
    return NextResponse.json(
      { error: "Could not save that." },
      { status: 400 },
    );
  }
}
