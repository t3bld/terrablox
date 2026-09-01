import { NextResponse } from "next/server";
import {
  getHarnessCuration,
  mergeHarnessCuration,
  saveHarnessOverrides,
} from "@/lib/agent/harness-curation";
import { HARNESS_ELEMENTS, HARNESS_PLANES } from "@/lib/agent/harness-model";
import { AGENT_KNOWLEDGE } from "@/lib/agent/knowledge";
import {
  AGENT_HISTORY_BUDGET_CHARS,
  AGENT_MAX_MCP_CALLS,
  AGENT_MAX_STEPS,
  AGENT_MAX_TOOL_CALLS,
  DEFAULT_TURN_TIMEOUT_SECONDS,
  FALLBACK_MODELS,
} from "@/lib/agent/runtime-options";
import { getCurrentUserId } from "@/lib/auth/server-helpers";
import { database } from "@/lib/database";
import { DEFAULT_SUBMODULES_FOLDER } from "@/lib/modules/submodule-discovery";
import {
  ARCHITECTURE_MAP,
  architectureEntry,
  CONTAINMENT_ATTRIBUTES,
} from "@/lib/terraform/aws-architecture";
import {
  COST_DRIVER_MAP,
  FREE_RESOURCE_TYPES,
  NO_CHARGE_SUFFIXES,
  resolveCostDriver,
} from "@/lib/terraform/aws-cost-drivers";
import { AWS_ICON_NAMES } from "@/lib/terraform/aws-icon-manifest";
import {
  ICON_BY_SERVICE,
  SERVICE_BY_PREFIX,
  SERVICE_BY_TYPE,
} from "@/lib/terraform/aws-services";
import { CONVENTIONAL_LABELS } from "@/lib/terraform/resource-label";

/**
 * Everything in TerraBlox that a person decided rather than a machine derived.
 *
 * The point is not the lists themselves — those are in the source — but reading
 * them *against the data*: which of the 400-odd resource types your catalogue
 * actually contains have an answer, and which are still guessed at. A curated
 * table is only as good as its overlap with what people import, and that overlap
 * is invisible from the source file.
 *
 * No write side. Everything here lives in version control, where a change is
 * reviewable; an editor on this page would move that decision into a database row
 * nobody reviews.
 */
export async function GET() {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Distinct resource types this installation has actually seen, which is what
  // makes the coverage numbers below mean anything.
  const seen = await database.providerResource.groupBy({
    by: ["resourceType"],
    where: { kind: "resource" },
    _count: { resourceType: true },
  });

  const catalogue = seen
    .map((row) => ({
      type: row.resourceType,
      uses: row._count.resourceType,
    }))
    .sort((a, b) => b.uses - a.uses || a.type.localeCompare(b.type));

  const uses = catalogue.reduce((sum, entry) => sum + entry.uses, 0);

  const costUnclassified = catalogue.filter(
    (entry) => resolveCostDriver(entry.type) === null,
  );
  const architectureUnclassified = catalogue.filter(
    (entry) => !architectureEntry(entry.type),
  );

  return NextResponse.json({
    catalogue: {
      types: catalogue.length,
      uses,
    },

    cost: {
      curated: Object.entries(COST_DRIVER_MAP).map(([type, entry]) => ({
        type,
        costClass: entry.costClass,
        driver: entry.driver ?? null,
        sizedBy: entry.sizedBy ?? [],
      })),
      freeList: [...FREE_RESOURCE_TYPES].sort(),
      suffixRule: NO_CHARGE_SUFFIXES,
      coverage: {
        classified: catalogue.length - costUnclassified.length,
        unclassified: costUnclassified,
        usesUnclassified: costUnclassified.reduce((s, e) => s + e.uses, 0),
      },
    },

    architecture: {
      curated: Object.entries(ARCHITECTURE_MAP).map(([type, entry]) => ({
        type,
        role: entry.role,
        label: entry.label ?? null,
        icon: entry.icon ?? null,
        group: entry.group ?? null,
        global: entry.global ?? false,
      })),
      containment: CONTAINMENT_ATTRIBUTES,
      coverage: {
        classified: catalogue.length - architectureUnclassified.length,
        unclassified: architectureUnclassified,
        usesUnclassified: architectureUnclassified.reduce(
          (s, e) => s + e.uses,
          0,
        ),
      },
    },

    services: {
      byType: SERVICE_BY_TYPE,
      byPrefix: SERVICE_BY_PREFIX,
      iconByService: ICON_BY_SERVICE,
      iconsVendored: AWS_ICON_NAMES.length,
    },

    // The editable half, twice over: what is in force, and what the code says.
    // The editor needs both — it can only offer "put this back" and send just the
    // genuinely changed fields if it knows the default it is being compared to.
    // Sending everything as an override would freeze today's wording and stop
    // future code changes from ever reaching anyone.
    harness: await getHarnessCuration(),
    harnessDefaults: mergeHarnessCuration({}, null),

    agent: {
      knowledge: AGENT_KNOWLEDGE,
      planes: HARNESS_PLANES.map((plane) => ({
        id: plane.id,
        label: plane.label,
        elements: HARNESS_ELEMENTS.filter(
          (element) => element.plane === plane.id,
        ).map((element) => ({
          label: element.label,
          enforcement: element.enforcement,
          setting: element.setting ?? null,
          source: element.source,
        })),
      })),
      fallbackModels: FALLBACK_MODELS.map((model) => model.id),
      limits: {
        // A default rather than a ceiling since the budgets became settings, and
        // named so: this screen edits the rules for everyone, and `{maxToolCalls}`
        // in a rule is substituted per user with whatever that person chose.
        defaultMaxToolCalls: AGENT_MAX_TOOL_CALLS,
        defaultMaxMcpCalls: AGENT_MAX_MCP_CALLS,
        // A default too, for the same reason: the trail size is a per-user
        // setting now, so this screen can only report what an unset one gets.
        defaultMaxRecordedSteps: AGENT_MAX_STEPS,
        historyBudgetChars: AGENT_HISTORY_BUDGET_CHARS,
        defaultTurnTimeoutSeconds: DEFAULT_TURN_TIMEOUT_SECONDS,
      },
    },

    conventions: {
      conventionalLabels: [...CONVENTIONAL_LABELS].sort(),
      submodulesFolder: DEFAULT_SUBMODULES_FOLDER,
    },
  });
}

/**
 * Replaces the editable overrides.
 *
 * A full replace, not a patch: the editor holds the whole set, and "put this
 * field back to the code default" has to be expressible. With a patch it would
 * need a verb of its own, and a missing key would be ambiguous between "unchanged"
 * and "reset".
 *
 * Everything sent is validated in `parseHarnessOverrides` — unknown ids, wrong
 * types and over-long text are dropped rather than rejected, because the caller is
 * a form and a single bad field should not lose the rest of the edit.
 */
export async function PUT(request: Request) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
  }

  try {
    return NextResponse.json({
      harness: await saveHarnessOverrides(userId, body),
    });
  } catch (error) {
    console.error("[admin] failed to save harness curation", error);
    const reason = error instanceof Error ? error.message : String(error);

    // Returned rather than hidden: this is a self-hosted tool whose operator is
    // the person reading the message, and the realistic failure — a pending
    // migration — is invisible from the UI but obvious from the text.
    return NextResponse.json(
      { error: `Could not save: ${reason}` },
      { status: 500 },
    );
  }
}
