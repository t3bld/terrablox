import { NextResponse } from "next/server";
import { z } from "zod";
import {
  parseJsonBody,
  requireUserId,
  requireUserWithLimit,
} from "@/lib/api/guard";
import { RATE_LIMITS } from "@/lib/api/rate-limit";
import { badRequest, notFound, routeError } from "@/lib/api/route-error";
import * as schema from "@/lib/api/schemas";
import { readProjectAwsState } from "@/lib/aws/project-connection";
import { database } from "@/lib/database";
import { findOwnedProject } from "@/lib/projects/service";

/**
 * The AWS account one project deploys into.
 *
 * Project-scoped on purpose. The old user-level status said "this user has some
 * AWS connection", which unlocked the Deploy tab of a project that had no account
 * of its own and then failed the moment it tried to read anything.
 */
export async function GET(
  _request: Request,
  { params }: { params: { projectId: string } },
) {
  try {
    const userId = await requireUserId({ action: "project.aws.read" });

    const project = await findOwnedProject(userId, params.projectId);
    if (!project) return notFound("Project not found");

    return NextResponse.json({
      aws: await readProjectAwsState(userId, project),
    });
  } catch (error) {
    return routeError("project.aws.read", error);
  }
}

/** An empty region means "leave the project's own region alone". */
const bindBody = z.object({
  accountId: schema.accountId,
  region: z.union([schema.region, z.literal("")]).optional(),
});

/**
 * Points this project at one of the user's connected accounts.
 *
 * Separate from the connect flow, which creates the connection: signing in to an
 * AWS account and deciding that *this* project deploys into it are two decisions,
 * and only the second one is per project.
 */
export async function PUT(
  request: Request,
  { params }: { params: { projectId: string } },
) {
  try {
    const userId = await requireUserWithLimit(
      "project.aws.write",
      RATE_LIMITS.infrastructure,
    );

    const project = await findOwnedProject(userId, params.projectId);
    if (!project) return notFound("Project not found");

    const body = await parseJsonBody(request, bindBody);
    const region = body.region ?? "";

    // The account has to be one the user actually signed in to. Without this check
    // a project could name any account and the tabs would unlock on a connection
    // that does not exist.
    //
    // Note the `userId` in the where-clause: it is what stops a project from being
    // pointed at an account belonging to somebody else who happens to have connected
    // it, which a lookup by `accountId` alone would allow.
    const connection = await database.awsConnection.findFirst({
      where: { userId, accountId: body.accountId },
      select: { id: true, region: true },
    });

    if (!connection) {
      return badRequest(`Account ${body.accountId} is not connected.`);
    }

    const updated = await database.project.update({
      where: { id: project.id },
      data: {
        awsAccountId: body.accountId,
        ...(region ? { awsRegion: region } : {}),
      },
    });

    return NextResponse.json({
      aws: await readProjectAwsState(userId, updated),
    });
  } catch (error) {
    return routeError("project.aws.write", error);
  }
}

/** Unlinks the account, leaving the sign-in itself alone. */
export async function DELETE(
  _request: Request,
  { params }: { params: { projectId: string } },
) {
  try {
    const userId = await requireUserWithLimit(
      "project.aws.write",
      RATE_LIMITS.infrastructure,
    );

    const project = await findOwnedProject(userId, params.projectId);
    if (!project) return notFound("Project not found");

    const updated = await database.project.update({
      where: { id: project.id },
      data: { awsAccountId: null },
    });

    return NextResponse.json({
      aws: await readProjectAwsState(userId, updated),
    });
  } catch (error) {
    return routeError("project.aws.write", error);
  }
}
