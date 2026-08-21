import { NextResponse } from "next/server";

import { getCurrentUserId } from "@/lib/auth/server-helpers";
import { resolveProjectAwsSession } from "@/lib/aws/credentials";
import { awsRouteError } from "@/lib/aws/route-error";
import {
  createStateBucket,
  inspectStateBackend,
} from "@/lib/aws/state-backend";
import { stateKey } from "@/lib/projects/deploy";
import { findOwnedProject } from "@/lib/projects/service";

/**
 * The Terraform state backend, read from and created in the customer's account.
 *
 * Everything else about deployment happens in the pipeline, which is the right
 * place for anything that touches infrastructure. The backend is the exception:
 * it is the one thing that must exist *before* the first pipeline run, and
 * making the user leave the app for a CLI to create a single bucket is where
 * setting up a project stalls.
 */

interface Params {
  params: { projectId: string };
}

/** Reports the backend's real state. Read-only, so it is safe on page load. */
export async function GET(_req: Request, { params }: Params) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const project = await findOwnedProject(userId, params.projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  if (!project.stateBucket) {
    return NextResponse.json({
      connected: true,
      status: null,
      message: "No state bucket is configured for this project yet.",
    });
  }

  const resolved = await resolveProjectAwsSession(userId, project);
  if (!resolved.ok) {
    // Not an error: a project without a connection is a normal, early state,
    // and the page needs the reason to offer the right next step.
    return NextResponse.json({
      connected: false,
      reason: resolved.reason,
      message: resolved.message,
      status: null,
    });
  }

  try {
    const status = await inspectStateBackend(resolved.session, {
      bucket: project.stateBucket,
      key: stateKey(project.name),
    });

    return NextResponse.json({ connected: true, status });
  } catch (error) {
    return awsRouteError(error);
  }
}

/** Creates the bucket. The only write this route makes, and never implicit. */
export async function POST(_req: Request, { params }: Params) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const project = await findOwnedProject(userId, params.projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  if (!project.stateBucket) {
    return NextResponse.json(
      { error: "Set a state bucket name on the project first." },
      { status: 400 },
    );
  }

  const resolved = await resolveProjectAwsSession(userId, project, "write");
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.message }, { status: 400 });
  }

  try {
    await createStateBucket(resolved.session, { bucket: project.stateBucket });

    const status = await inspectStateBackend(resolved.session, {
      bucket: project.stateBucket,
      key: stateKey(project.name),
    });

    return NextResponse.json({ connected: true, status });
  } catch (error) {
    return awsRouteError(error);
  }
}
