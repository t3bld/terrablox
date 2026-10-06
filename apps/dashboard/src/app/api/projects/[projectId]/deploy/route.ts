import type { Prisma } from "@terrablox/database";
import { GithubRequestError } from "@terrablox/git/client";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  parseJsonBody,
  requireUserId,
  requireUserWithLimit,
} from "@/lib/api/guard";
import { RATE_LIMITS } from "@/lib/api/rate-limit";
import { notFound, routeError, unauthorized } from "@/lib/api/route-error";
import * as schema from "@/lib/api/schemas";
import { getProviderTokenForRequest } from "@/lib/auth/server-helpers";
import { database } from "@/lib/database";
import { readDeployState } from "@/lib/projects/deploy-service";
import { findOwnedProject } from "@/lib/projects/service";
import { resolveTemplateConfig } from "@/lib/projects/workflow-templates";

export async function GET(
  req: Request,
  { params }: { params: { projectId: string } },
) {
  try {
    const userId = await requireUserId({ action: "deploy.read" });

    const project = await findOwnedProject(userId, params.projectId);
    if (!project) return notFound("Project not found");

    const token = await getProviderTokenForRequest(req, project.provider);
    if (!token) return unauthorized("GitHub is not connected");

    return NextResponse.json({ deploy: await readDeployState(token, project) });
  } catch (e) {
    if (e instanceof GithubRequestError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    return routeError("deploy.read", e);
  }
}

/**
 * The deployment settings a person can change.
 *
 * Every field here ends up in a file Terrablox generates and commits, which is why
 * they are all pattern-constrained rather than merely trimmed:
 *
 *   - `stateBucket` and `stateKmsKeyArn` are interpolated into `backend.tf`, inside
 *     double-quoted HCL strings. Unvalidated, a value containing `"` closed the
 *     string and appended arbitrary Terraform to a file labelled "Managed by
 *     Terrablox" — which `terraform init` then read and applied through a role
 *     holding AdministratorAccess. They were the only two fields on this route
 *     without a pattern, while the three AWS identifiers beside them had one.
 *   - `awsRegion`, `awsRoleArn` and `awsAccountId` reach the workflow YAML.
 *
 * `.nullable()` on the optional ones because clearing a field is a real operation:
 * `null` unsets, an absent key leaves the stored value alone. `z.optional()` and
 * `.nullable()` therefore mean different things here and both are needed.
 */
const patchBody = z.object({
  awsAccountId: schema.accountId.nullable().optional(),
  awsRegion: schema.region.optional(),
  awsRoleArn: schema.roleArn.nullable().optional(),
  stateBucket: schema.bucketName.nullable().optional(),
  stateKmsKeyArn: schema.kmsKeyArn.nullable().optional(),
  /** Workflow template configuration, normalised again by the catalogue. */
  templates: z.unknown().optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: { projectId: string } },
) {
  try {
    const userId = await requireUserWithLimit(
      "deploy.write",
      RATE_LIMITS.infrastructure,
    );

    const project = await findOwnedProject(userId, params.projectId);
    if (!project) return notFound("Project not found");

    const body = await parseJsonBody(req, patchBody);

    const updated = await database.project.update({
      where: { id: project.id },
      data: {
        ...(body.awsAccountId !== undefined
          ? { awsAccountId: body.awsAccountId }
          : {}),
        ...(body.awsRoleArn !== undefined
          ? { awsRoleArn: body.awsRoleArn }
          : {}),
        ...(body.awsRegion !== undefined ? { awsRegion: body.awsRegion } : {}),
        ...(body.stateBucket !== undefined
          ? { stateBucket: body.stateBucket }
          : {}),
        ...(body.stateKmsKeyArn !== undefined
          ? { stateKmsKeyArn: body.stateKmsKeyArn }
          : {}),
        // Stored through the catalogue's normaliser rather than as given: this is
        // a JSON column, and an unknown template id or a bogus version string must
        // never reach a renderer.
        ...(body.templates !== undefined
          ? {
              deployTemplates: {
                ...resolveTemplateConfig(body.templates),
              } satisfies Record<string, unknown> as Prisma.InputJsonObject,
            }
          : {}),
      },
    });

    const token = await getProviderTokenForRequest(req, updated.provider);
    if (!token) return unauthorized("GitHub is not connected");

    return NextResponse.json({ deploy: await readDeployState(token, updated) });
  } catch (e) {
    return routeError("deploy.write", e);
  }
}
