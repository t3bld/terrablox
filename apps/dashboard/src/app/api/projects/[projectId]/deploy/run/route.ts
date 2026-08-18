import { NextResponse } from "next/server";

import {
  getCurrentUserId,
  getProviderTokenForRequest,
} from "@/lib/auth/server-helpers";
import {
  dispatchWorkflow,
  GithubRequestError,
  listWorkflowRuns,
} from "@/lib/github/repo-files";
import {
  APPLY_WORKFLOW_PATH,
  COST_WORKFLOW_PATH,
  missingDeploySettings,
  PLAN_WORKFLOW_PATH,
  STATE_WORKFLOW_PATH,
} from "@/lib/projects/deploy";
import { findOwnedProject } from "@/lib/projects/service";
import type { DeployRunKind } from "@/lib/projects/types";

const WORKFLOW_BY_KIND: Record<DeployRunKind, string> = {
  plan: PLAN_WORKFLOW_PATH,
  apply: APPLY_WORKFLOW_PATH,
  state: STATE_WORKFLOW_PATH,
  cost: COST_WORKFLOW_PATH,
};

function parseKind(value: unknown): DeployRunKind | null {
  return value === "plan" ||
    value === "apply" ||
    value === "state" ||
    value === "cost"
    ? value
    : null;
}

/** Just the runs, so the UI can follow a job without re-reading the repository. */
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
    const runs = await listWorkflowRuns(token, {
      repoFullName: project.repoFullName,
    });

    return NextResponse.json({ runs });
  } catch {
    return NextResponse.json({ runs: [] });
  }
}

/**
 * Starts a Terraform run.
 *
 * TerraBlox holds no AWS credentials, so it cannot call AWS itself. It starts
 * the workflow that can, and that workflow federates into the account for the
 * length of the job. The practical effect is the same — Terraform runs from a
 * button — but the credentials stay where they can be audited and revoked, and
 * every change still leaves a run log in GitHub.
 */
export async function POST(
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

  const body = (await req.json().catch(() => null)) as {
    workflow?: unknown;
  } | null;

  const kind = parseKind(body?.workflow);
  if (!kind) {
    return NextResponse.json(
      { error: "workflow must be one of: plan, apply, state" },
      { status: 400 },
    );
  }

  // Dispatching an unconfigured pipeline would start a job that fails a minute
  // later in the console rather than here, where the reason can be shown.
  const missing = missingDeploySettings({
    awsAccountId: project.awsAccountId,
    awsRegion: project.awsRegion,
    awsRoleArn: project.awsRoleArn,
    stateBucket: project.stateBucket,
    stateLockTable: project.stateLockTable,
  });

  if (missing.length > 0) {
    return NextResponse.json(
      { error: `Still missing: ${missing.join(", ")}.` },
      { status: 409 },
    );
  }

  const token = await getProviderTokenForRequest(req, project.provider);
  if (!token) {
    return NextResponse.json(
      { error: "GitHub is not connected" },
      { status: 401 },
    );
  }

  try {
    await dispatchWorkflow(token, {
      repoFullName: project.repoFullName,
      workflowFile: WORKFLOW_BY_KIND[kind],
      ref: project.repoBranch,
    });

    return NextResponse.json({ started: true, workflow: kind });
  } catch (e) {
    if (e instanceof GithubRequestError && e.status === 404) {
      return NextResponse.json(
        {
          error:
            "The workflow is not on the repository's default branch yet. Generate the pipeline first.",
        },
        { status: 409 },
      );
    }

    if (e instanceof GithubRequestError && e.status === 403) {
      return NextResponse.json(
        {
          error:
            "Starting workflows needs the 'actions: write' permission on the GitHub app installation.",
        },
        { status: 403 },
      );
    }

    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to start the run" },
      { status: e instanceof GithubRequestError ? e.status : 500 },
    );
  }
}
