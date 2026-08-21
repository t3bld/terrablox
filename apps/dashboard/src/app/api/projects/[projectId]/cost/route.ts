import { NextResponse } from "next/server";

import {
  getCurrentUserId,
  getProviderTokenForRequest,
} from "@/lib/auth/server-helpers";
import {
  dispatchWorkflow,
  GithubRequestError,
  readRepoFile,
} from "@/lib/github/repo-files";
import { hasInfracostApiKey } from "@/lib/integrations/infracost";
import { type ProjectCostDto, parseCostSnapshot } from "@/lib/projects/cost";
import { COST_SNAPSHOT_PATH } from "@/lib/projects/deploy";
import { findOwnedProject } from "@/lib/projects/service";
import { findTemplate } from "@/lib/projects/workflow-templates";

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

  const fileUrl = `https://github.com/${project.repoFullName}/blob/${project.repoBranch}/${COST_SNAPSHOT_PATH}`;

  // Without the user's own key there is nothing to price with, so the estimate
  // is not read at all rather than shown as stale data they cannot refresh.
  if (!(await hasInfracostApiKey(userId))) {
    const cost: ProjectCostDto = {
      snapshot: null,
      fileUrl,
      hasWorkflow: false,
      hasApiKey: false,
      problem: null,
    };

    return NextResponse.json({ cost });
  }

  const token = await getProviderTokenForRequest(req, project.provider);
  if (!token) {
    return NextResponse.json(
      { error: "GitHub is not connected" },
      { status: 401 },
    );
  }

  try {
    const [snapshotFile, workflowFile] = await Promise.all([
      readRepoFile(token, {
        repoFullName: project.repoFullName,
        path: COST_SNAPSHOT_PATH,
        ref: project.repoBranch,
      }),
      readRepoFile(token, {
        repoFullName: project.repoFullName,
        path: findTemplate("cost")?.path ?? "",
        ref: project.repoBranch,
      }),
    ]);

    const snapshot = snapshotFile
      ? parseCostSnapshot(snapshotFile.content)
      : null;

    const cost: ProjectCostDto = {
      snapshot,
      fileUrl,
      hasWorkflow: workflowFile !== null,
      hasApiKey: true,
      problem:
        snapshotFile && !snapshot
          ? "The cost estimate could not be read. It may have been edited by hand."
          : null,
    };

    return NextResponse.json({ cost });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to read the estimate" },
      { status: e instanceof GithubRequestError ? e.status : 500 },
    );
  }
}

/**
 * Asks the pipeline for a fresh estimate.
 *
 * Pricing needs a plan, and a plan needs credentials TerraBlox deliberately
 * does not hold, so refreshing means triggering the workflow that can produce
 * one. The result arrives as a commit a few minutes later.
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

  if (!(await hasInfracostApiKey(userId))) {
    return NextResponse.json(
      {
        error:
          "Connect your own Infracost API key in Account Settings before estimating costs.",
      },
      { status: 400 },
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
      workflowFile: findTemplate("cost")?.path ?? "",
      ref: project.repoBranch,
    });

    return NextResponse.json({ started: true });
  } catch (e) {
    if (e instanceof GithubRequestError && e.status === 404) {
      return NextResponse.json(
        {
          error:
            "The cost workflow is not in the repository yet. Generate the pipeline from the Deploy tab first.",
        },
        { status: 404 },
      );
    }

    return NextResponse.json(
      {
        error: e instanceof Error ? e.message : "Failed to start the estimate",
      },
      { status: e instanceof GithubRequestError ? e.status : 500 },
    );
  }
}
