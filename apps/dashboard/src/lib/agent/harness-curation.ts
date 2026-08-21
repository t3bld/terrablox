import "server-only";

import { prisma } from "@terrablox/database";
import { HARNESS_ELEMENTS, HARNESS_PLANES } from "./harness-model";
import { AGENT_KNOWLEDGE } from "./knowledge";
import {
  DEFAULT_OPERATING_RULES,
  renderOperatingRule,
} from "./runtime-options";
import { PROJECT_AGENT_TOOLS } from "./tool-catalogue";

/**
 * The harness texts a person can edit without a deploy.
 *
 * The defaults for the operating rules live in `runtime-options` rather than here
 * so that this module — which needs the database — is not pulled in by the prompt
 * builder, which must stay free of it.
 *
 * Which texts, and why not all of them. Three kinds of thing live in the harness
 * tables and only two of them are opinions:
 *
 *   wording       what the agent is told and what the screens say — an opinion,
 *                 iterated on constantly, and worth changing without a release
 *   structure     which operations exist, their JSON schemas — code, because a
 *                 broken schema breaks the agent silently
 *   claims        the enforcement class of an element, and the code path beside
 *                 it — statements *about* the code, so editing them would only
 *                 make the screen lie
 *
 * So this store carries wording. `enforcement`, `source`, `parameters` and the
 * tool list are absent on purpose, and the admin page shows them read-only.
 *
 * The defaults stay in the source. An empty row therefore behaves exactly like
 * the code, and clearing an override is a working undo — which is the property
 * that makes this safe to hand to somebody at 6pm.
 */

/** Fixed key: there is one curation, and it is upsertable without a lookup. */
const ROW_ID = "default";

export interface CuratedOperation {
  name: string;
  group: string;
  /** Shown in settings. */
  label: string;
  /** Shown in settings, under the label. */
  summary: string;
  /** Sent to the model as the tool's description. */
  description: string;
  /** True when any of the three above differ from the code. */
  overridden: boolean;
}

export interface CuratedKnowledge {
  id: string;
  name: string;
  description: string;
  overridden: boolean;
}

export interface CuratedElement {
  id: string;
  plane: string;
  label: string;
  /** Diagram text. */
  brief: string;
  /** Card text. */
  description: string;
  /** Read-only: a claim about the code, not a preference. */
  enforcement: string;
  /** Read-only, same reason. */
  source: string;
  overridden: boolean;
}

export interface CuratedPlane {
  id: string;
  label: string;
  summary: string;
  integration: string;
  overridden: boolean;
}

export interface HarnessCuration {
  /** Ready to use: `{maxToolCalls}` already substituted. */
  operatingRules: string[];
  /** As stored or defaulted, placeholder intact, for the editor. */
  operatingRulesRaw: string[];
  operatingRulesOverridden: boolean;
  operations: CuratedOperation[];
  knowledge: CuratedKnowledge[];
  elements: CuratedElement[];
  planes: CuratedPlane[];
  updatedAt: string | null;
}

/** The editable shape, as the admin page sends it. */
export interface HarnessOverrides {
  operatingRules?: string[];
  operations?: Record<
    string,
    { label?: string; summary?: string; description?: string }
  >;
  knowledge?: Record<string, { name?: string; description?: string }>;
  elements?: Record<string, { brief?: string; description?: string }>;
  planes?: Record<string, { summary?: string; integration?: string }>;
}

/** Long enough for a real house rule, short enough not to crowd out the graph. */
const MAX_TEXT = 2000;
const MAX_RULES = 12;

function cleanText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_TEXT) return undefined;
  return trimmed;
}

/**
 * Reads the stored JSON defensively.
 *
 * The column outlives any one version of this code, so an override for a field
 * that no longer exists, or a value of the wrong type, is dropped here rather
 * than reaching a prompt. Unknown ids go the same way: an operation renamed in
 * code must not keep being described by the old row.
 */
export function parseHarnessOverrides(value: unknown): HarnessOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const raw = value as Record<string, unknown>;
  const out: HarnessOverrides = {};

  if (Array.isArray(raw.operatingRules)) {
    const rules = raw.operatingRules
      .map((rule) => cleanText(rule))
      .filter((rule): rule is string => rule !== undefined)
      .slice(0, MAX_RULES);
    if (rules.length > 0) out.operatingRules = rules;
  }

  const pickFields = <K extends string>(
    source: unknown,
    knownIds: ReadonlySet<string>,
    fields: readonly K[],
  ): Record<string, Partial<Record<K, string>>> | undefined => {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      return undefined;
    }

    const result: Record<string, Partial<Record<K, string>>> = {};

    for (const [id, entry] of Object.entries(source)) {
      if (!knownIds.has(id) || !entry || typeof entry !== "object") continue;

      const record = entry as Record<string, unknown>;
      const kept: Partial<Record<K, string>> = {};

      for (const field of fields) {
        const text = cleanText(record[field]);
        if (text !== undefined) kept[field] = text;
      }

      if (Object.keys(kept).length > 0) result[id] = kept;
    }

    return Object.keys(result).length > 0 ? result : undefined;
  };

  const operations = pickFields(
    raw.operations,
    new Set(PROJECT_AGENT_TOOLS.map((tool) => tool.name)),
    ["label", "summary", "description"] as const,
  );
  if (operations) out.operations = operations;

  const knowledge = pickFields(
    raw.knowledge,
    new Set(AGENT_KNOWLEDGE.map((source) => source.id)),
    ["name", "description"] as const,
  );
  if (knowledge) out.knowledge = knowledge;

  const elements = pickFields(
    raw.elements,
    new Set(HARNESS_ELEMENTS.map((element) => element.id)),
    ["brief", "description"] as const,
  );
  if (elements) out.elements = elements;

  const planes = pickFields(
    raw.planes,
    new Set(HARNESS_PLANES.map((plane) => plane.id)),
    ["summary", "integration"] as const,
  );
  if (planes) out.planes = planes;

  return out;
}

/** Code defaults merged with whatever is stored, with each override marked. */
export function mergeHarnessCuration(
  overrides: HarnessOverrides,
  updatedAt: Date | null,
): HarnessCuration {
  const rulesRaw = overrides.operatingRules ?? [...DEFAULT_OPERATING_RULES];

  return {
    operatingRules: rulesRaw.map(renderOperatingRule),
    operatingRulesRaw: rulesRaw,
    operatingRulesOverridden: overrides.operatingRules !== undefined,

    operations: PROJECT_AGENT_TOOLS.map((tool) => {
      const over = overrides.operations?.[tool.name];
      return {
        name: tool.name,
        group: tool.group,
        label: over?.label ?? tool.label,
        summary: over?.summary ?? tool.summary,
        description: over?.description ?? tool.description,
        overridden: over !== undefined,
      };
    }),

    knowledge: AGENT_KNOWLEDGE.map((source) => {
      const over = overrides.knowledge?.[source.id];
      return {
        id: source.id,
        name: over?.name ?? source.name,
        description: over?.description ?? source.description,
        overridden: over !== undefined,
      };
    }),

    elements: HARNESS_ELEMENTS.map((element) => {
      const over = overrides.elements?.[element.id];
      return {
        id: element.id,
        plane: element.plane,
        label: element.label,
        brief: over?.brief ?? element.brief,
        description: over?.description ?? element.description,
        enforcement: element.enforcement,
        source: element.source,
        overridden: over !== undefined,
      };
    }),

    planes: HARNESS_PLANES.map((plane) => {
      const over = overrides.planes?.[plane.id];
      return {
        id: plane.id,
        label: plane.label,
        summary: over?.summary ?? plane.summary,
        integration: over?.integration ?? plane.integration,
        overridden: over !== undefined,
      };
    }),

    updatedAt: updatedAt?.toISOString() ?? null,
  };
}

/**
 * The curation in force, or the code defaults.
 *
 * A read failure returns the defaults rather than throwing: the agent must keep
 * working when this table is unreachable, and the defaults are by definition a
 * usable answer.
 */
export async function getHarnessCuration(): Promise<HarnessCuration> {
  try {
    const row = await prisma.harnessCuration.findUnique({
      where: { id: ROW_ID },
    });

    return mergeHarnessCuration(
      parseHarnessOverrides(row?.overrides),
      row?.updatedAt ?? null,
    );
  } catch {
    return mergeHarnessCuration({}, null);
  }
}

/** The raw overrides, for the editor to show what is actually stored. */
export async function getHarnessOverrides(): Promise<HarnessOverrides> {
  const row = await prisma.harnessCuration.findUnique({
    where: { id: ROW_ID },
  });
  return parseHarnessOverrides(row?.overrides);
}

/**
 * Replaces the whole override object.
 *
 * A replace rather than a patch, because the editor holds the full set and
 * "reset this field" has to be expressible — with a patch, removing an override
 * would need its own verb.
 */
export async function saveHarnessOverrides(
  userId: string,
  input: unknown,
): Promise<HarnessCuration> {
  const clean = parseHarnessOverrides(input);
  // Round-tripped so Prisma sees a plain value: the interface has optional keys,
  // which its `InputJsonValue` type will not accept.
  const overrides = JSON.parse(JSON.stringify(clean));

  const row = await prisma.harnessCuration.upsert({
    where: { id: ROW_ID },
    create: { id: ROW_ID, overrides, updatedBy: userId },
    update: { overrides, updatedBy: userId },
  });

  return mergeHarnessCuration(clean, row.updatedAt);
}
