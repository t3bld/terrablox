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
import {
  STATE_SNAPSHOT_PATH,
  STATE_WORKFLOW_PATH,
} from "@/lib/projects/deploy";
import { findOwnedProject } from "@/lib/projects/service";
import { type ProjectStateDto, parseStateSnapshot } from "@/lib/projects/state";

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
    const [snapshotFile, workflowFile] = await Promise.all([
      readRepoFile(token, {
        repoFullName: project.repoFullName,
        path: STATE_SNAPSHOT_PATH,
        ref: project.repoBranch,
      }),
      readRepoFile(token, {
        repoFullName: project.repoFullName,
        path: STATE_WORKFLOW_PATH,
        ref: project.repoBranch,
      }),
    ]);

    const snapshot = snapshotFile
      ? parseStateSnapshot(snapshotFile.content)
      : null;

    const state: ProjectStateDto = {
      snapshot,
      region: project.awsRegion,
      fileUrl: `https://github.com/${project.repoFullName}/blob/${project.repoBranch}/${STATE_SNAPSHOT_PATH}`,
      hasWorkflow: workflowFile !== null,
      problem:
        snapshotFile && !snapshot
          ? "The state snapshot could not be read. It may have been edited by hand."
          : null,
    };

    return NextResponse.json({ state });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to read state" },
      { status: e instanceof GithubRequestError ? e.status : 500 },
    );
  }
}

/**
 * Asks the pipeline for a fresh snapshot.
 *
 * TerraBlox cannot read the state bucket itself — it holds no AWS credentials —
 * so refreshing means triggering the workflow that can, and the result arrives
 * as a commit a minute or two later.
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
      workflowFile: STATE_WORKFLOW_PATH,
      ref: project.repoBranch,
    });

    return NextResponse.json({ started: true });
  } catch (e) {
    if (e instanceof GithubRequestError && e.status === 404) {
      return NextResponse.json(
        {
          error:
            "The state workflow is not on the repository's default branch yet. Generate the pipeline in the Deploy tab first.",
        },
        { status: 409 },
      );
    }

    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to start the refresh" },
      { status: e instanceof GithubRequestError ? e.status : 500 },
    );
  }
}
