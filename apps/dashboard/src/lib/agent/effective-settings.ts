import "server-only";

import { prisma } from "@terrablox/database";

import { isKnownKnowledge } from "./knowledge";
import {
  type AgentSettingsView,
  getAgentSettings,
  type McpServerView,
  REASONING_EFFORTS,
  type ReasoningEffortValue,
} from "./settings-service";
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
  disabledKnowledge?: string[];
  disabledTools?: string[];
  turnTimeout?: number | null;
  /**
   * Whether the agent may delete in this project.
   *
   * Worth overriding per project more than any other field here: a scratch
   * project and one behind a production account deserve different answers, and
   * the answer is not a preference about the agent but about the blast radius.
   */
  allowDestructive?: boolean;
}

export type AgentSettingField = keyof AgentOverrides;

export interface EffectiveAgentSettings {
  instructions: string;
  model: string | null;
  reasoningEffort: ReasoningEffortValue | null;
  disabledKnowledge: string[];
  disabledTools: string[];
  /**
   * The outside tool providers this user connected.
   *
   * Not in {@link AgentOverrides} and deliberately not overridable: a server is a
   * URL plus a credential of the user's, and a project that could enable one
   * would be enabling a connection its owner might not have looked at. Carried
   * through here only so the settings view has one shape in both scopes.
   */
  mcpServers: McpServerView[];
  /** How long a turn may run, in seconds. Null → default (300s). */
  turnTimeout: number | null;
  /** Whether the agent may delete modules and variables here. */
  allowDestructive: boolean;
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
    disabledKnowledge: overrides.disabledKnowledge ?? global.disabledKnowledge,
    disabledTools: overrides.disabledTools ?? global.disabledTools,
    // Passed through rather than merged: there is no override to consider, and a
    // project reads the same connections its owner enabled.
    mcpServers: global.mcpServers,
    turnTimeout: overrides.turnTimeout ?? global.turnTimeout,
    // `??` is wrong for a boolean override: a project that deliberately set
    // `false` would fall through to a global `true`. Presence is the question.
    allowDestructive:
      overrides.allowDestructive !== undefined
        ? overrides.allowDestructive
        : global.allowDestructive,
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

  if (Array.isArray(raw.disabledKnowledge)) {
    overrides.disabledKnowledge = raw.disabledKnowledge.filter(
      (entry): entry is string =>
        typeof entry === "string" && isKnownKnowledge(entry),
    );
  }

  if (Array.isArray(raw.disabledTools)) {
    overrides.disabledTools = raw.disabledTools.filter(
      (entry): entry is string =>
        typeof entry === "string" && isKnownTool(entry),
    );
  }

  if ("turnTimeout" in raw) {
    const t = Number(raw.turnTimeout);
    overrides.turnTimeout =
      Number.isFinite(t) && t >= 30 && t <= 1800 ? Math.round(t) : null;
  }

  // Only a real boolean counts. Anything else is dropped rather than coerced,
  // because coercing an unexpected value here could only ever err towards
  // granting a permission.
  if (typeof raw.allowDestructive === "boolean") {
    overrides.allowDestructive = raw.allowDestructive;
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
