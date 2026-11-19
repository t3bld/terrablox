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
import { audit } from "@/lib/audit/log";
import { removeSetupRoles } from "@/lib/aws/credentials";
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
      orderBy: [
        { verifiedAt: { sort: "desc", nulls: "last" } },
        { createdAt: "desc" },
      ],
      select: {
        id: true,
        region: true,
        label: true,
        credentialMode: true,
        ssoStartUrl: true,
        ssoRegion: true,
        ssoRoleName: true,
      },
    });

    if (!connection) {
      return badRequest(`Account ${body.accountId} is not connected.`);
    }

    const updated = await database.project.update({
      where: { id: project.id },
      data: {
        awsAccountId: body.accountId,
        ...(region ? { awsRegion: region } : {}),
        // Remembered on the project, so the next sign-in to this account is one
        // click: the portal, the permission set and the account's name stay
        // known after the sign-in itself expired or was disconnected.
        ...(connection.credentialMode === "sso" &&
        connection.ssoStartUrl &&
        connection.ssoRoleName
          ? {
              awsSsoStartUrl: connection.ssoStartUrl,
              awsSsoRegion: connection.ssoRegion,
              awsSsoRoleName: connection.ssoRoleName,
              awsAccountLabel: connection.label || null,
            }
          : {}),
      },
    });

    return NextResponse.json({
      aws: await readProjectAwsState(userId, updated),
    });
  } catch (error) {
    return routeError("project.aws.write", error);
  }
}

/**
 * Disconnects the account: unlinks the project and removes the stored sign-in.
 *
 * It used to unlink only, leaving the SSO session in the database. Signing in
 * again with another permission set then added a second row beside the first,
 * and whichever row a lookup happened to pick decided which permissions a stack
 * was created with. Disconnect has to mean the old session can no longer be used.
 *
 * Only SSO sign-ins are removed. An `assume-role` connection is a role in the
 * customer's account with an external id in its trust policy, and deleting the
 * row would orphan that setup; it stays manageable from the connections list.
 * Sign-ins are per account, not per project, so the user's other projects in
 * this account have to sign in again as well.
 */
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

    const accountId = project.awsAccountId;

    // Before the rows go: deleting the setup role needs the sign-in they hold.
    if (accountId) {
      await removeSetupRoles(
        await database.awsConnection.findMany({
          where: { userId, accountId, credentialMode: "sso" },
        }),
      );
    }

    const updated = await database.$transaction(async (tx) => {
      const unlinked = await tx.project.update({
        where: { id: project.id },
        data: { awsAccountId: null },
      });
      // Guarded: without an account, a filter on `userId` alone would remove
      // every sign-in this user has.
      if (accountId) {
        await tx.awsConnection.deleteMany({
          where: { userId, accountId, credentialMode: "sso" },
        });
      }
      return unlinked;
    });

    await audit({
      action: "aws.connection.deleted",
      userId,
      subject: project.id,
      detail: { accountId, via: "project.disconnect" },
    });

    return NextResponse.json({
      aws: await readProjectAwsState(userId, updated),
    });
  } catch (error) {
    return routeError("project.aws.write", error);
  }
}
