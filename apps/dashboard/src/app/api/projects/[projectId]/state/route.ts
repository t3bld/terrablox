import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/auth/server-helpers";
import { stateReadPolicy } from "@/lib/aws/connection";
import { resolveProjectAwsSession } from "@/lib/aws/credentials";
import { awsRouteError } from "@/lib/aws/route-error";
import { readStateObject } from "@/lib/aws/state-backend";
import { stateKey } from "@/lib/projects/deploy";
import { findOwnedProject } from "@/lib/projects/service";
import type { ProjectStateDto } from "@/lib/projects/state";
import { parseTerraformState } from "@/lib/projects/tfstate";

/**
 * What is actually deployed, read from the Terraform state in S3.
 *
 * The state is the only honest answer to that question — the code says what
 * should exist, and the two drift after a failed apply or a change made in the
 * console. It used to arrive as a summary the pipeline committed into the
 * repository, which meant the tab was only ever as current as the last workflow
 * run. Reading the bucket makes it current as of this request.
 *
 * The trade that comes with it: raw state holds generated passwords and private
 * keys in clear text. So the session is narrowed to this one object, and the
 * parser keeps identifiers only. Nothing but `id`, `arn` and non-sensitive
 * outputs leaves this route.
 */
export async function GET(
  _req: Request,
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

  const bucket = project.stateBucket;
  const key = stateKey(project.name);

  const base: ProjectStateDto = {
    snapshot: null,
    region: project.awsRegion,
    bucket,
    key,
    configured: bucket !== null,
    connected: false,
    problem: null,
  };

  if (!bucket) {
    return NextResponse.json({
      state: {
        ...base,
        problem:
          "No state backend yet. Run the setup in the Deploy tab — it creates the encrypted bucket this reads from.",
      },
    });
  }

  // A session that may read this object and decrypt it with this key, and
  // nothing else. Narrower than the default read-only cap, which cannot express
  // kms:Decrypt at all.
  const resolved = await resolveProjectAwsSession(
    userId,
    project,
    "read",
    stateReadPolicy({
      bucket,
      key,
      kmsKeyArn: project.stateKmsKeyArn,
    }),
  );

  if (!resolved.ok) {
    return NextResponse.json({
      state: { ...base, problem: resolved.message },
    });
  }

  try {
    const object = await readStateObject(resolved.session, { bucket, key });

    if (!object) {
      return NextResponse.json({
        state: {
          ...base,
          connected: true,
          problem:
            "The bucket is reachable but holds no state yet. Run an apply in the Deploy tab.",
        },
      });
    }

    const snapshot = parseTerraformState(object.body, {
      lastModified: object.lastModified,
    });

    return NextResponse.json({
      state: {
        ...base,
        connected: true,
        snapshot,
        problem: snapshot
          ? null
          : "The Terraform state could not be read. It may have been written by a newer Terraform than this supports.",
      },
    });
  } catch (error) {
    return awsRouteError(error);
  }
}
