import { AGENT_KNOWLEDGE } from "@terrablox/agent-harness/knowledge";
import { PROJECT_AGENT_TOOLS } from "@terrablox/agent-harness/tool-catalogue";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  type AgentOverrides,
  getEffectiveAgentSettings,
  parseOverrides,
  saveAgentOverrides,
} from "@/lib/agent/effective-settings";
import { getAgentSettings } from "@/lib/agent/settings-service";
import { parseJsonBody } from "@/lib/api/guard";
import { routeError } from "@/lib/api/route-error";
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
      disabledKnowledge: global.disabledKnowledge,
      disabledTools: global.disabledTools,
    },
    catalogue: {
      knowledge: AGENT_KNOWLEDGE.map(({ id, name, description }) => ({
        id,
        name,
        description,
      })),
      tools: PROJECT_AGENT_TOOLS.map(({ name, group, label, summary }) => ({
        name,
        group,
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

  // `parseOverrides` and `saveAgentOverrides` own the field rules — they are shared
  // with the project-create snapshot — so the schema here is shape and size only.
  let body: AgentOverrides;
  try {
    body = (await parseJsonBody(
      request,
      z.record(z.string().max(100), z.unknown()),
    )) as AgentOverrides;
  } catch (error) {
    return routeError("agent.project-settings", error);
  }

  try {
    await saveAgentOverrides(userId, params.projectId, body);
    return NextResponse.json({
      overrides: parseOverrides(body),
      effective: await getEffectiveAgentSettings(userId, params.projectId),
    });
  } catch (error) {
    console.error("[agent] failed to save project overrides", error);

    const reason = error instanceof Error ? error.message : String(error);

    return NextResponse.json(
      { error: `Could not save that: ${reason}` },
      { status: 400 },
    );
  }
}
