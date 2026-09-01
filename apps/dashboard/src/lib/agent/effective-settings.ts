import "server-only";

import { prisma } from "@terrablox/database";

import { isKnownKnowledge } from "./knowledge";
import {
  APP_REPO_FILE_CHARS_MAX,
  APP_REPO_FILE_CHARS_MIN,
  APP_REPO_READS_MAX,
  APP_REPO_READS_MIN,
  APP_REPO_TREE_MAX,
  APP_REPO_TREE_MIN,
  HISTORY_BUDGET_MAX_CHARS,
  HISTORY_BUDGET_MIN_CHARS,
  MCP_CALL_BUDGET_MAX,
  STEP_TRAIL_MAX,
  STEP_TRAIL_MIN,
  TOOL_CALL_BUDGET_MAX,
  TOOL_CALL_BUDGET_MIN,
} from "./runtime-options";
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
   * The per-turn budgets, overridable because blast radius is a property of the
   * project rather than of the person: a scratch project and one wired to a
   * production account deserve different answers about how much one unreviewed
   * turn may change.
   */
  maxToolCalls?: number | null;
  maxMcpCalls?: number | null;
  /**
   * How much of this project's conversation is replayed.
   *
   * Per project more obviously than any other budget here: it is this project's
   * own chat, and how much of it is worth carrying is a fact about this project.
   */
  historyBudgetChars?: number | null;
  /**
   * How much of a turn is recorded here.
   *
   * Per project because the transcript is per project: the one somebody reviews
   * carefully wants the whole trail, and a scratch project reading back forty
   * lookups is noise they have to scroll past.
   */
  maxSteps?: number | null;
  /**
   * How far a turn may read into the linked application.
   *
   * Per project for the same reason the link itself is: the application is a fact
   * about this project, and how much of it is worth reading is a fact about that
   * application rather than about the user.
   */
  maxAppRepoReads?: number | null;
  appRepoTreeLimit?: number | null;
  appRepoFileChars?: number | null;
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
  /** How long a turn may run, in seconds. Null → the default. */
  turnTimeout: number | null;
  /** Operations one turn may queue here. Null → default. */
  maxToolCalls: number | null;
  /** MCP tool calls one turn may make here. Null → default. */
  maxMcpCalls: number | null;
  /** Characters of this project's conversation replayed. Null → default. */
  historyBudgetChars: number | null;
  /** Entries of one turn recorded here. Null → default. */
  maxSteps: number | null;
  /** Reads of the linked application repository per turn. Null → default. */
  maxAppRepoReads: number | null;
  /** Paths one application listing returns. Null → default. */
  appRepoTreeLimit: number | null;
  /** Characters of one application file handed to the model. Null → default. */
  appRepoFileChars: number | null;
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
    maxToolCalls: overrides.maxToolCalls ?? global.maxToolCalls,
    maxMcpCalls: overrides.maxMcpCalls ?? global.maxMcpCalls,
    historyBudgetChars:
      overrides.historyBudgetChars ?? global.historyBudgetChars,
    maxSteps: overrides.maxSteps ?? global.maxSteps,
    maxAppRepoReads: overrides.maxAppRepoReads ?? global.maxAppRepoReads,
    appRepoTreeLimit: overrides.appRepoTreeLimit ?? global.appRepoTreeLimit,
    appRepoFileChars: overrides.appRepoFileChars ?? global.appRepoFileChars,
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

  // Out of range reads as "inherit" rather than as a number: this column is JSON
  // that outlives any one version of the bounds, and a stored 500 must not become
  // a 500-operation turn just because it was written before the ceiling existed.
  const budget = (value: unknown, max: number) => {
    const count = Number(value);
    return Number.isFinite(count) &&
      count >= TOOL_CALL_BUDGET_MIN &&
      count <= max
      ? Math.round(count)
      : null;
  };

  if ("maxToolCalls" in raw) {
    overrides.maxToolCalls = budget(raw.maxToolCalls, TOOL_CALL_BUDGET_MAX);
  }

  if ("maxMcpCalls" in raw) {
    overrides.maxMcpCalls = budget(raw.maxMcpCalls, MCP_CALL_BUDGET_MAX);
  }

  if ("historyBudgetChars" in raw) {
    const chars = Number(raw.historyBudgetChars);
    overrides.historyBudgetChars =
      Number.isFinite(chars) &&
      chars >= HISTORY_BUDGET_MIN_CHARS &&
      chars <= HISTORY_BUDGET_MAX_CHARS
        ? Math.round(chars)
        : null;
  }

  /**
   * A stored number, or null when it is outside today's bounds.
   *
   * Same reasoning as the call budgets above: the column is JSON that outlives any
   * one version of these limits, so a value written before a ceiling moved reads as
   * "inherit" rather than as a number the code would no longer accept.
   */
  const bounded = (value: unknown, min: number, max: number) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : null;
  };

  if ("maxSteps" in raw) {
    overrides.maxSteps = bounded(raw.maxSteps, STEP_TRAIL_MIN, STEP_TRAIL_MAX);
  }

  if ("maxAppRepoReads" in raw) {
    overrides.maxAppRepoReads = bounded(
      raw.maxAppRepoReads,
      APP_REPO_READS_MIN,
      APP_REPO_READS_MAX,
    );
  }

  if ("appRepoTreeLimit" in raw) {
    overrides.appRepoTreeLimit = bounded(
      raw.appRepoTreeLimit,
      APP_REPO_TREE_MIN,
      APP_REPO_TREE_MAX,
    );
  }

  if ("appRepoFileChars" in raw) {
    overrides.appRepoFileChars = bounded(
      raw.appRepoFileChars,
      APP_REPO_FILE_CHARS_MIN,
      APP_REPO_FILE_CHARS_MAX,
    );
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
