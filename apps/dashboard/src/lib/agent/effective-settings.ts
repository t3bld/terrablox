import "server-only";

import { prisma } from "@terrablox/database";

import {
  type AgentSettingsView,
  getAgentSettings,
  REASONING_EFFORTS,
  type ReasoningEffortValue,
} from "./settings-service";
import { isKnownSkill } from "./skills";
import { isKnownTool } from "./tool-catalogue";

/**
 * Global agent settings, narrowed by whatever a project overrides.
 *
 * A key that is absent from the override means "inherit", the same way a
 * workspace setting falls back to a user setting. That distinction is why the
 * overrides are stored as JSON: an empty skill list is a real choice and must
 * not read as "not set".
 */

/** The fields a project may take over. Absent means inherited. */
export interface AgentOverrides {
  model?: string | null;
  reasoningEffort?: ReasoningEffortValue | null;
  skills?: string[];
  disabledTools?: string[];
}

export type AgentSettingField = keyof AgentOverrides;

export interface EffectiveAgentSettings {
  instructions: string;
  model: string | null;
  reasoningEffort: ReasoningEffortValue | null;
  skills: string[];
  disabledTools: string[];
  /** Which fields the project decides itself, for the UI to mark as overridden. */
  overridden: AgentSettingField[];
}

export async function getEffectiveAgentSettings(
  userId: string,
  projectId: string,
): Promise<EffectiveAgentSettings> {
  const [global, project] = await Promise.all([
    getAgentSettings(userId),
    prisma.project.findFirst({
      where: { id: projectId, userId },
      select: { agentOverrides: true },
    }),
  ]);

  return mergeAgentSettings(global, parseOverrides(project?.agentOverrides));
}

export function mergeAgentSettings(
  global: AgentSettingsView,
  overrides: AgentOverrides,
): EffectiveAgentSettings {
  const overridden = (Object.keys(overrides) as AgentSettingField[]).filter(
    (field) => overrides[field] !== undefined,
  );

  return {
    instructions: global.instructions,
    model: overrides.model ?? global.model,
    reasoningEffort: overrides.reasoningEffort ?? global.reasoningEffort,
    skills: overrides.skills ?? global.skills,
    disabledTools: overrides.disabledTools ?? global.disabledTools,
    overridden,
  };
}

/**
 * Reads the stored JSON defensively.
 *
 * The column is written by us, but it is still JSON in a database that outlives
 * any one version of this code, so an unknown skill or a retired tool name is
 * dropped here rather than reaching a session.
 */
export function parseOverrides(value: unknown): AgentOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const raw = value as Record<string, unknown>;
  const overrides: AgentOverrides = {};

  if ("model" in raw) {
    overrides.model =
      typeof raw.model === "string" && raw.model ? raw.model : null;
  }

  if ("reasoningEffort" in raw) {
    overrides.reasoningEffort = REASONING_EFFORTS.includes(
      raw.reasoningEffort as ReasoningEffortValue,
    )
      ? (raw.reasoningEffort as ReasoningEffortValue)
      : null;
  }

  if (Array.isArray(raw.skills)) {
    overrides.skills = raw.skills.filter(
      (entry): entry is string =>
        typeof entry === "string" && isKnownSkill(entry),
    );
  }

  if (Array.isArray(raw.disabledTools)) {
    overrides.disabledTools = raw.disabledTools.filter(
      (entry): entry is string =>
        typeof entry === "string" && isKnownTool(entry),
    );
  }

  return overrides;
}

export async function saveAgentOverrides(
  userId: string,
  projectId: string,
  overrides: AgentOverrides,
): Promise<AgentOverrides> {
  const clean = parseOverrides(overrides);

  // Scoped by userId so a guessed project id cannot rewrite someone else's
  // agent. `updateMany` returns a count instead of throwing on no match.
  const { count } = await prisma.project.updateMany({
    where: { id: projectId, userId },
    // Round-tripped through JSON so Prisma sees a plain value: `AgentOverrides`
    // has optional keys, which its `InputJsonValue` type will not accept.
    data: { agentOverrides: JSON.parse(JSON.stringify(clean)) },
  });

  if (count === 0) throw new Error("Project not found.");

  return clean;
}
