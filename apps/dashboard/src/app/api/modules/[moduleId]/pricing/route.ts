import { NextResponse } from "next/server";
import { z } from "zod";

import { parseJsonBody, requireCaller } from "@/lib/api/guard";
import { RATE_LIMITS } from "@/lib/api/rate-limit";
import { routeError } from "@/lib/api/route-error";
import { githubTokenForUser } from "@/lib/auth/server-helpers";
import {
  loadModuleArchitectures,
  type ModuleArchitectureRecord,
} from "@/lib/module-library/architecture-service";
import { priceModuleResources } from "@/lib/module-library/cost-pricing";
import { loadModuleDetail } from "@/lib/module-library/detail-service";
import {
  estimateEc2ModuleScenario,
  estimateGenericModuleScenario,
  ModuleCostEstimateError,
  validateGenericScenarioInputs,
} from "@/lib/module-library/infracost-scenario";
import { supportsEc2InfracostScenario } from "@/lib/module-library/infracost-scenario-support";
import { parseVariables } from "@/lib/module-library/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

const ec2ScenarioSchema = z.object({
  instanceCount: z.number().int().min(1).max(20),
  instanceType: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9.]{1,29}$/),
  monitoring: z.boolean(),
  createEip: z.boolean(),
  tenancy: z.enum(["default", "dedicated"]),
  rootVolume: z.object({
    enabled: z.boolean(),
    type: z.enum(["gp2", "gp3", "io1", "io2"]),
    size: z.number().int().min(1).max(16_384),
    iops: z.number().int().min(100).max(256_000),
    throughput: z.number().int().min(1).max(4_000),
  }),
});

const genericScenarioSchema = z.object({
  kind: z.literal("generic"),
  moduleCount: z.number().int().min(1).max(20),
  inputs: z.record(z.string(), z.unknown()),
});
const scenarioSchema = z.union([ec2ScenarioSchema, genericScenarioSchema]);

/** Current public list-price scenario inputs for one visible library module. */
export async function GET(
  request: Request,
  { params }: { params: { moduleId: string } },
) {
  try {
    const caller = await requireCaller({
      request,
      scope: "modules.cost-estimate",
      limit: RATE_LIMITS.costEstimate,
    });
    const userId = caller.userId;
    const moduleId = params.moduleId?.trim();
    if (!moduleId) {
      return NextResponse.json({ error: "Missing moduleId" }, { status: 400 });
    }

    const region = "eu-west-1";

    const module = await loadModuleDetail(userId, moduleId);
    if (!module) {
      return NextResponse.json({ error: "Module not found" }, { status: 404 });
    }

    const architectures = await loadModuleArchitectures(userId, [moduleId], 4);
    const resources = Object.values(architectures).flatMap(
      (record: ModuleArchitectureRecord) =>
        record.resources.flatMap((resource) => {
          if (!resource || typeof resource !== "object") return [];
          const candidate = resource as {
            kind?: unknown;
            resourceType?: unknown;
          };
          return typeof candidate.kind === "string" &&
            typeof candidate.resourceType === "string"
            ? [
                {
                  kind: candidate.kind,
                  resourceType: candidate.resourceType,
                },
              ]
            : [];
        }),
    );
    const pricing = await priceModuleResources(
      resources,
      parseVariables(module.variables),
      region,
    );
    return NextResponse.json(pricing, {
      headers: {
        "Cache-Control": "private, max-age=300, stale-while-revalidate=1800",
      },
    });
  } catch (error) {
    return routeError("modules.pricing", error);
  }
}

/** Recalculates an EC2 module scenario through the isolated Infracost service. */
export async function POST(
  request: Request,
  { params }: { params: { moduleId: string } },
) {
  try {
    const caller = await requireCaller({
      request,
      scope: "modules.cost-scenario",
      limit: RATE_LIMITS.costScenario,
    });
    const scenario = await parseJsonBody(request, scenarioSchema);
    const moduleId = params.moduleId?.trim();
    if (!moduleId) {
      return NextResponse.json({ error: "Missing moduleId" }, { status: 400 });
    }

    const module = await loadModuleDetail(caller.userId, moduleId);
    if (!module) {
      return NextResponse.json({ error: "Module not found" }, { status: 404 });
    }
    const variables = parseVariables(module.variables);
    if ("kind" in scenario && scenario.kind === "generic") {
      const sourceUrl = module.source?.url ?? module.url;
      if (!sourceUrl || !module.versionTag) {
        return NextResponse.json(
          { error: "This module has no pinned repository source." },
          { status: 422 },
        );
      }
      const estimate = await estimateGenericModuleScenario({
        sourceUrl,
        versionTag: module.versionTag,
        terraformRootFolder: module.terraformRootFolder,
        scenario: {
          moduleCount: scenario.moduleCount,
          inputs: validateGenericScenarioInputs(variables, scenario.inputs),
        },
        githubToken: (await githubTokenForUser(caller.userId)) ?? "",
        signal: request.signal,
      });
      return NextResponse.json(
        { estimate },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const ec2Scenario = ec2ScenarioSchema.parse(scenario);
    const supportsEc2Scenario = supportsEc2InfracostScenario({
      sourceUrl: module.source?.url,
      resources: module.resources,
      variables,
    });
    if (!supportsEc2Scenario) {
      return NextResponse.json(
        { error: "This module does not support the EC2 cost scenario." },
        { status: 422 },
      );
    }
    if (!module.source?.url || !module.versionTag) {
      return NextResponse.json(
        { error: "This module has no pinned repository source." },
        { status: 422 },
      );
    }

    const estimate = await estimateEc2ModuleScenario({
      sourceUrl: module.source.url,
      versionTag: module.versionTag,
      terraformRootFolder: module.terraformRootFolder,
      scenario: ec2Scenario,
      githubToken: (await githubTokenForUser(caller.userId)) ?? "",
      signal: request.signal,
    });

    return NextResponse.json(
      { estimate },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof ModuleCostEstimateError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }
    return routeError("modules.pricing.estimate", error);
  }
}
