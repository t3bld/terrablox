import { NextResponse } from "next/server";
import { z } from "zod";

import {
  parseJsonBody,
  requireUserId,
  requireUserWithLimit,
} from "@/lib/api/guard";
import { RATE_LIMITS } from "@/lib/api/rate-limit";
import { routeError } from "@/lib/api/route-error";
import { getProviderTokenForRequest } from "@/lib/auth/server-helpers";
import { database } from "@/lib/database";
import {
  CostEstimationError,
  estimateProjectCosts,
  readProjectCosts,
} from "@/lib/projects/cost-estimation";
import {
  type CostUsageAssumptions,
  readCostUsageAssumptions,
} from "@/lib/projects/cost-usage";
import { findOwnedProject } from "@/lib/projects/service";

export const runtime = "nodejs";
export const maxDuration = 180;

export async function GET(
  request: Request,
  { params }: { params: { projectId: string } },
) {
  try {
    const userId = await requireUserId({ action: "project-costs.read" });
    const project = await findOwnedProject(userId, params.projectId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    const token = await getProviderTokenForRequest(request, project.provider);
    if (!token) {
      return NextResponse.json(
        { error: "GitHub is not connected" },
        { status: 401 },
      );
    }

    return NextResponse.json({
      costs: await readProjectCosts(token, project),
    });
  } catch (error) {
    return routeError("project-costs.read", error);
  }
}

export async function POST(
  request: Request,
  { params }: { params: { projectId: string } },
) {
  try {
    const userId = await requireUserWithLimit(
      "project-costs.estimate",
      RATE_LIMITS.costEstimate,
    );
    const body = await parseJsonBody(
      request,
      z.object({
        refresh: z.boolean().optional().default(false),
        usageAssumptions: z
          .record(
            z.string(),
            z.record(z.string(), z.number().min(0).max(1_000_000_000_000_000)),
          )
          .optional(),
      }),
    );
    const project = await findOwnedProject(userId, params.projectId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    const token = await getProviderTokenForRequest(request, project.provider);
    if (!token) {
      return NextResponse.json(
        { error: "GitHub is not connected" },
        { status: 401 },
      );
    }

    const usageAssumptions: CostUsageAssumptions | undefined =
      body.usageAssumptions === undefined
        ? undefined
        : readCostUsageAssumptions(body.usageAssumptions);
    const effectiveProject = usageAssumptions
      ? await database.project.update({
          where: { id: project.id },
          data: {
            costUsage: JSON.parse(JSON.stringify(usageAssumptions)),
          },
        })
      : project;

    return NextResponse.json({
      snapshot: await estimateProjectCosts({
        token,
        project: effectiveProject,
        force: body.refresh,
        ...(usageAssumptions ? { usageAssumptions } : {}),
      }),
    });
  } catch (error) {
    if (error instanceof CostEstimationError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }
    return routeError("project-costs.estimate", error);
  }
}
