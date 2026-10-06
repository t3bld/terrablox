import { GithubRequestError } from "@terrablox/git/client";
import { NextResponse } from "next/server";
import { requireUserWithLimit } from "@/lib/api/guard";
import { RATE_LIMITS } from "@/lib/api/rate-limit";
import { routeError } from "@/lib/api/route-error";
import { audit } from "@/lib/audit/log";
import { getProviderTokenForRequest } from "@/lib/auth/server-helpers";
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
  // Writes `.github/workflows/**` to the user's repository — files GitHub will
  // execute, and which need the `workflow` OAuth scope to commit at all. That makes it
  // an infrastructure-budget action rather than an ordinary write.
  let userId: string;
  try {
    userId = await requireUserWithLimit(
      "deploy.pipeline",
      RATE_LIMITS.infrastructure,
    );
  } catch (e) {
    return routeError("deploy.pipeline", e);
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

    // The commit sha is the whole point of the row: it ties the audit trail to the
    // exact workflow content that will run, which is the thing a reviewer would want
    // to look up later.
    await audit({
      action: "deploy.pipeline.written",
      userId,
      subject: project.id,
      detail: {
        repo: project.repoFullName,
        branch: project.repoBranch,
        ...(commit && typeof commit === "object" && "sha" in commit
          ? { sha: (commit as { sha?: unknown }).sha }
          : {}),
      },
    });

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
