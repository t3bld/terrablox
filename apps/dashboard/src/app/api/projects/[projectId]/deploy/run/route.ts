import { dispatchWorkflow, listWorkflowRuns } from "@terrablox/git/actions";
import { GithubRequestError } from "@terrablox/git/client";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  parseJsonBody,
  requireUserId,
  requireUserWithLimit,
} from "@/lib/api/guard";
import { RATE_LIMITS } from "@/lib/api/rate-limit";
import { routeError } from "@/lib/api/route-error";
import { audit } from "@/lib/audit/log";
import { getProviderTokenForRequest } from "@/lib/auth/server-helpers";
import { missingDeploySettings } from "@/lib/projects/deploy";
import { blockerFor } from "@/lib/projects/deploy-runs";
import { templateConfig } from "@/lib/projects/deploy-service";
import { runPreflightRefusal } from "@/lib/projects/run-preflight";
import { findOwnedProject } from "@/lib/projects/service";
import type { DeployRunKind } from "@/lib/projects/types";
import {
  activeTemplates,
  dispatchInputs,
  findTemplate,
  isWorkflowTemplateId,
  runConfirmed,
} from "@/lib/projects/workflow-templates";

/** Just the runs, so the UI can follow a job without re-reading the repository. */
export async function GET(
  req: Request,
  { params }: { params: { projectId: string } },
) {
  let userId: string;
  try {
    userId = await requireUserId({ action: "deploy.run.list" });
  } catch (e) {
    return routeError("deploy.run.list", e);
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
 * Terrablox holds no AWS credentials, so it cannot call AWS itself. It starts
 * the workflow that can, and that workflow federates into the account for the
 * length of the job. The practical effect is the same — Terraform runs from a
 * button — but the credentials stay where they can be audited and revoked, and
 * every change still leaves a run log in GitHub.
 */
export async function POST(
  req: Request,
  { params }: { params: { projectId: string } },
) {
  // Rate limited on the infrastructure budget: this starts a GitHub Actions job that
  // runs `terraform apply` against a customer account with a role holding
  // AdministratorAccess. It is the most expensive button in the app, in both senses.
  let userId: string;
  try {
    userId = await requireUserWithLimit(
      "deploy.run",
      RATE_LIMITS.infrastructure,
    );
  } catch (e) {
    return routeError("deploy.run", e);
  }

  const project = await findOwnedProject(userId, params.projectId);
  if (!project) {
    await audit({
      action: "deploy.run.started",
      userId,
      subject: params.projectId,
      outcome: "denied",
      detail: { reason: "not-owner-or-missing" },
    });
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  let kind: DeployRunKind;
  let confirm: string | undefined;
  try {
    const body = await parseJsonBody(
      req,
      z.object({
        workflow: z.string().max(64),
        confirm: z.string().max(256).optional(),
      }),
    );
    confirm = body.confirm;
    if (!isWorkflowTemplateId(body.workflow)) {
      return NextResponse.json(
        { error: "That workflow is not in the catalogue." },
        { status: 400 },
      );
    }
    kind = body.workflow;
  } catch (e) {
    return routeError("deploy.run", e);
  }

  const template = findTemplate(kind);
  if (!template) {
    return NextResponse.json(
      { error: "That workflow is not in the catalogue." },
      { status: 400 },
    );
  }

  if (!runConfirmed(template, project.name, confirm)) {
    return NextResponse.json(
      {
        error: `${template.name} removes infrastructure. Type the project's name ("${project.name}") to confirm.`,
      },
      { status: 400 },
    );
  }

  // Only what the project chose in the setup: a turned-off workflow has no file
  // in the repository, so dispatching it would fail on GitHub's side anyway.
  const enabled = activeTemplates(templateConfig(project));
  if (!enabled.some((entry) => entry.id === template.id)) {
    return NextResponse.json(
      { error: `${template.name} is turned off for this project.` },
      { status: 409 },
    );
  }

  // Dispatching an unconfigured pipeline would start a job that fails a minute
  // later in the console rather than here, where the reason can be shown.
  const missing = missingDeploySettings({
    awsAccountId: project.awsAccountId,
    awsRegion: project.awsRegion,
    awsRoleArn: project.awsRoleArn,
    stateBucket: project.stateBucket,
    stateKmsKeyArn: project.stateKmsKeyArn,
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

  // Values AWS would reject part-way through an apply. See runPreflightRefusal.
  const refusal = await runPreflightRefusal(token, project, template);
  if (refusal) {
    return NextResponse.json({ error: refusal }, { status: 409 });
  }

  // Never alongside a run it shares a lock with, or a second copy of itself.
  // The tab locks its buttons, but a second tab must not be able to queue a plan
  // behind an apply that is still holding the state lock. Best-effort: if the
  // list cannot be read, the apply workflow's `concurrency` group still queues.
  try {
    const blocker = blockerFor(template, {
      runs: await listWorkflowRuns(token, {
        repoFullName: project.repoFullName,
      }),
      workflows: enabled,
    });
    if (blocker?.kind === "run") {
      const { run } = blocker;
      return NextResponse.json(
        {
          error: `${run.name} is still ${run.status === "queued" ? "queued" : "running"}. Wait for it to finish before starting ${template.name}.`,
          activeRun: run,
        },
        { status: 409 },
      );
    }
  } catch {
    // Fall through to the dispatch.
  }

  try {
    await dispatchWorkflow(token, {
      repoFullName: project.repoFullName,
      workflowFile: template.path,
      ref: project.repoBranch,
      inputs: dispatchInputs(template, project.repoFullName),
    });

    // Recorded after the dispatch succeeded, so the trail says "a job was started"
    // rather than "somebody tried". `apply` is the row that matters months later.
    await audit({
      action: "deploy.run.started",
      userId,
      subject: project.id,
      detail: {
        workflow: kind,
        repo: project.repoFullName,
        ref: project.repoBranch,
        awsAccountId: project.awsAccountId,
        region: project.awsRegion,
      },
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
            "GitHub refused to start the workflow. The Terrablox GitHub App needs the Actions permission at read and write, and this repository has to be one the installation was granted.",
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
