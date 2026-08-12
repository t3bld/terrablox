import { NextResponse } from "next/server";

import {
  getCurrentUserId,
  getProviderTokenForRequest,
} from "@/lib/auth/server-helpers";
import { GithubRequestError } from "@/lib/github/repo-files";
import {
  readDeployState,
  writeDeployPipeline,
} from "@/lib/projects/deploy-service";
import { findOwnedProject } from "@/lib/projects/service";

/** Commits the generated workflows (and the backend file, if state is configured). */
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

  if (!project.awsRoleArn) {
    return NextResponse.json(
      { error: "Set the IAM role ARN before generating the pipeline" },
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
    const commit = await writeDeployPipeline(token, project);
    return NextResponse.json({
      commit,
      deploy: await readDeployState(token, project),
    });
  } catch (e) {
    return NextResponse.json(
      {
        error: e instanceof Error ? e.message : "Failed to write the pipeline",
      },
      { status: e instanceof GithubRequestError ? e.status : 500 },
    );
  }
}
