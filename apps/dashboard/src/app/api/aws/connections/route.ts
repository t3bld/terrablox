import { NextResponse } from "next/server";
import { z } from "zod";
import {
  parseJsonBody,
  requireUserId,
  requireUserWithLimit,
} from "@/lib/api/guard";
import { RATE_LIMITS } from "@/lib/api/rate-limit";
import { routeError } from "@/lib/api/route-error";
import * as schema from "@/lib/api/schemas";
import { audit } from "@/lib/audit/log";
import {
  createConnection,
  listConnections,
} from "@/lib/aws/connection-service";

export async function GET() {
  try {
    const userId = await requireUserId({ action: "aws.connections.list" });
    return NextResponse.json(await listConnections(userId));
  } catch (error) {
    return routeError("aws.connections.list", error);
  }
}

/**
 * A new AWS connection.
 *
 * `roleArn` was only checked for being a string, which meant an arbitrary value
 * reached `sts:AssumeRole` and the failure came back as an AWS error rather than as a
 * field problem. The ARN pattern is the same one the deploy route uses, from
 * `lib/api/schemas`, so the two cannot drift.
 *
 * `region` keeps its default rather than being required: the client only sends one
 * when the user picked something other than the obvious.
 */
const createBody = z.object({
  label: schema.displayText(120).optional().default(""),
  roleArn: schema.roleArn,
  region: schema.region.optional().default("eu-central-1"),
});

export async function POST(req: Request) {
  try {
    const userId = await requireUserWithLimit(
      "aws.connections.write",
      RATE_LIMITS.infrastructure,
    );

    const body = await parseJsonBody(req, createBody);

    const connection = await createConnection(userId, {
      label: body.label,
      roleArn: body.roleArn,
      region: body.region,
    });

    // A credential record being created is worth a row: it is the moment this
    // installation gains the ability to act in an AWS account.
    await audit({
      action: "aws.connection.created",
      userId,
      subject: connection.id,
      detail: { roleArn: body.roleArn, region: body.region },
    });

    return NextResponse.json({ connection }, { status: 201 });
  } catch (error) {
    // `routeError` rather than `awsRouteError`: it already reports an
    // `AwsConnectionError` with its own message and a 400, and it is the only one of
    // the two that understands the `ApiError`s this route now throws for a failed
    // validation or a spent rate limit.
    return routeError("aws.connections.write", error);
  }
}
