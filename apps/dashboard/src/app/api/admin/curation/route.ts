import {
  HARNESS_ELEMENTS,
  HARNESS_PLANES,
} from "@terrablox/agent-harness/harness-model";
import { AGENT_KNOWLEDGE } from "@terrablox/agent-harness/knowledge";
import {
  AGENT_HISTORY_BUDGET_CHARS,
  AGENT_MAX_MCP_CALLS,
  AGENT_MAX_STEPS,
  AGENT_MAX_TOOL_CALLS,
  DEFAULT_TURN_TIMEOUT_SECONDS,
  FALLBACK_MODELS,
} from "@terrablox/agent-harness/runtime-options";
import {
  ARCHITECTURE_MAP,
  architectureEntry,
  CONTAINMENT_ATTRIBUTES,
} from "@terrablox/terraform/aws-architecture";
import {
  COST_DRIVER_MAP,
  FREE_RESOURCE_TYPES,
  NO_CHARGE_SUFFIXES,
  resolveCostDriver,
} from "@terrablox/terraform/aws-cost-drivers";
import { AWS_ICON_NAMES } from "@terrablox/terraform/aws-icon-manifest";
import {
  ICON_BY_SERVICE,
  SERVICE_BY_PREFIX,
  SERVICE_BY_TYPE,
} from "@terrablox/terraform/aws-services";
import { CONVENTIONAL_LABELS } from "@terrablox/terraform/resource-label";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getHarnessCuration,
  mergeHarnessCuration,
  saveHarnessOverrides,
} from "@/lib/agent/harness-curation";
import { parseJsonBody } from "@/lib/api/guard";
import { routeError } from "@/lib/api/route-error";
import { audit } from "@/lib/audit/log";
import { getCurrentUserId } from "@/lib/auth/server-helpers";
import { database } from "@/lib/database";
import { DEFAULT_SUBMODULES_FOLDER } from "@/lib/module-library/submodule-discovery";
import { visibleModulesForUser } from "@/lib/module-library/visibility";

/**
 * Everything in Terrablox that a person decided rather than a machine derived.
 *
 * The point is not the lists themselves — those are in the source — but reading
 * them *against the data*: which of the 400-odd resource types your catalogue
 * actually contains have an answer, and which are still guessed at. A curated
 * table is only as good as its overlap with what people import, and that overlap
 * is invisible from the source file.
 *
 * Everything on this screen is scoped to the caller. The classification tables are
 * the same for everyone because they live in version control, but the coverage
 * counts describe the caller's own catalogue and the harness wording is the
 * caller's own — there is no installation-wide state behind this route, which is
 * what lets it stay reachable without a role model.
 *
 * Named `admin` for historical reasons; it is a power-user screen, not a privileged
 * one. Nothing here reads or writes another account's data.
 */
export async function GET() {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Distinct resource types *this user's* catalogue contains, which is what makes
  // the coverage numbers below mean anything.
  //
  // Scoped through the module rather than counted installation-wide. An unfiltered
  // aggregate here was a cross-tenant read: the counts describe which AWS services
  // appear in somebody's imported modules, and on a shared instance that is a
  // detail about their infrastructure, not a property of the classification tables.
  // Builtins are included because `visibleToUser` admits them and they are the same
  // rows for everyone.
  const visibility = await visibleModulesForUser(userId);
  const seen = await database.providerResource.groupBy({
    by: ["resourceType"],
    where: { kind: "resource", module: { ...visibility } },
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
    harness: await getHarnessCuration(userId),
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
        // named so: `{maxToolCalls}` in a rule is substituted per turn with
        // whatever that person chose in their own agent settings.
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
 * Replaces the caller's own editable overrides.
 *
 * Scoped to the signed-in user, and that is the entire authorization story: the
 * row's primary key *is* the user id, so this cannot reach another account's
 * wording even by accident. It used to write a single installation-wide row, which
 * meant any signed-in account could edit the operating rules that go into every
 * other user's agent prompt.
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

  // `parseHarnessOverrides` owns the field rules and the text caps; this adds the
  // body-size limit and rejects a non-object outright rather than silently saving
  // an empty override set.
  let body: unknown;
  try {
    body = await parseJsonBody(
      request,
      z.record(z.string().max(100), z.unknown()),
    );
  } catch (error) {
    return routeError("harness.write", error);
  }

  try {
    const harness = await saveHarnessOverrides(userId, body);

    await audit({
      action: "harness.updated",
      userId,
      detail: { ruleCount: harness.operatingRulesRaw.length },
    });

    return NextResponse.json({ harness });
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
