import { NextResponse } from "next/server";

import {
  getCurrentUserId,
  getProviderTokenForRequest,
} from "@/lib/auth/server-helpers";
import { database } from "@/lib/database";
import { GithubRequestError } from "@/lib/github/repo-files";
import { readDeployState } from "@/lib/projects/deploy-service";
import { findOwnedProject } from "@/lib/projects/service";

export async function GET(
  req: Request,
  { params }: { params: { projectId: string } },
) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const project = await findOwnedProject(userId, params.projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const token = await getProviderTokenForRequest(req, project.provider);
  if (!token) {
    return NextResponse.json(
      { error: "GitHub is not connected" },
      { status: 401 },
    );
  }

  try {
    return NextResponse.json({ deploy: await readDeployState(token, project) });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to read deployment" },
      { status: e instanceof GithubRequestError ? e.status : 500 },
    );
  }
}

interface DeployPatchBody {
  awsAccountId?: string | null;
  awsRegion?: string;
  awsRoleArn?: string | null;
  stateBucket?: string | null;
  stateLockTable?: string | null;
}

const ROLE_ARN_PATTERN = /^arn:aws[a-z-]*:iam::\d{12}:role\/.+$/;
const ACCOUNT_ID_PATTERN = /^\d{12}$/;
const REGION_PATTERN = /^[a-z]{2}(-[a-z]+)+-\d$/;

/** Empty input clears the setting; whitespace-only input is the same thing. */
function optional(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value?.trim() ? value.trim() : null;
}

export async function PATCH(
  req: Request,
  { params }: { params: { projectId: string } },
) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const project = await findOwnedProject(userId, params.projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const body = (await req.json().catch(() => null)) as DeployPatchBody | null;
  if (!body) {
    return NextResponse.json({ error: "Missing body" }, { status: 400 });
  }

  const awsAccountId = optional(body.awsAccountId);
  const awsRoleArn = optional(body.awsRoleArn);
  const awsRegion = body.awsRegion?.trim();

  // Validated here because a typo only surfaces as a failed deployment
  // minutes later, in a log the user has to go looking for.
  if (awsAccountId && !ACCOUNT_ID_PATTERN.test(awsAccountId)) {
    return NextResponse.json(
      { error: "An AWS account ID is 12 digits" },
      { status: 400 },
    );
  }
  if (awsRoleArn && !ROLE_ARN_PATTERN.test(awsRoleArn)) {
    return NextResponse.json(
      {
        error:
          "Expected an IAM role ARN, e.g. arn:aws:iam::123456789012:role/deploy",
      },
      { status: 400 },
    );
  }
  if (awsRegion !== undefined && !REGION_PATTERN.test(awsRegion)) {
    return NextResponse.json(
      { error: "Expected an AWS region, e.g. eu-central-1" },
      { status: 400 },
    );
  }

  const updated = await database.project.update({
    where: { id: project.id },
    data: {
      ...(awsAccountId !== undefined ? { awsAccountId } : {}),
      ...(awsRoleArn !== undefined ? { awsRoleArn } : {}),
      ...(awsRegion !== undefined ? { awsRegion } : {}),
      ...(optional(body.stateBucket) !== undefined
        ? { stateBucket: optional(body.stateBucket) }
        : {}),
      ...(optional(body.stateLockTable) !== undefined
        ? { stateLockTable: optional(body.stateLockTable) }
        : {}),
    },
  });

  const token = await getProviderTokenForRequest(req, updated.provider);
  if (!token) {
    return NextResponse.json(
      { error: "GitHub is not connected" },
      { status: 401 },
    );
  }

  return NextResponse.json({ deploy: await readDeployState(token, updated) });
}
