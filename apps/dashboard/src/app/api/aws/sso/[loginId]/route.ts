import { NextResponse } from "next/server";
import { z } from "zod";
import {
  parseJsonBody,
  requireUserId,
  requireUserWithLimit,
} from "@/lib/api/guard";
import { RATE_LIMITS } from "@/lib/api/rate-limit";
import { notFound, routeError } from "@/lib/api/route-error";
import * as schema from "@/lib/api/schemas";
import { audit } from "@/lib/audit/log";
import {
  cancelSsoLogin,
  checkSsoLogin,
  completeSsoLogin,
} from "@/lib/aws/sso-service";

/**
 * Which account and role the approved login becomes a connection for.
 *
 * `accountId` and `roleName` only had to be strings, so a typo reached AWS and came
 * back as an API error rather than as a field problem. The account pattern is the
 * shared one; `roleName` follows IAM's own character class.
 */
const completeBody = z.object({
  accountId: schema.accountId,
  roleName: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[\w+=,.@-]+$/, "That is not a valid IAM role name"),
  region: schema.region.optional(),
  label: schema.displayText(120).optional(),
});

/** Polled by the browser while the user approves in the AWS portal. */
export async function GET(
  _req: Request,
  { params }: { params: { loginId: string } },
) {
  try {
    const userId = await requireUserId({ action: "aws.sso.poll" });

    const status = await checkSsoLogin(userId, params.loginId);
    if (!status) return notFound();

    return NextResponse.json(status);
  } catch (error) {
    return routeError("aws.sso.poll", error);
  }
}

/** Picks the account, creates the role there, and connects it. */
export async function POST(
  req: Request,
  { params }: { params: { loginId: string } },
) {
  try {
    const userId = await requireUserWithLimit(
      "aws.sso.complete",
      RATE_LIMITS.infrastructure,
    );

    const body = await parseJsonBody(req, completeBody);

    const connection = await completeSsoLogin(userId, params.loginId, {
      accountId: body.accountId,
      roleName: body.roleName,
      region: body.region ?? "eu-central-1",
      label: body.label ?? "",
    });

    if (!connection) return notFound();

    // The login has become a stored credential at this point, which is the event
    // worth keeping rather than the polling that led to it.
    await audit({
      action: "aws.sso.completed",
      userId,
      subject: connection.id,
      detail: {
        accountId: body.accountId,
        roleName: body.roleName,
        region: body.region ?? "eu-central-1",
      },
    });

    return NextResponse.json({ connection }, { status: 201 });
  } catch (error) {
    return routeError("aws.sso.complete", error);
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: { loginId: string } },
) {
  try {
    const userId = await requireUserWithLimit("aws.sso.cancel");

    await cancelSsoLogin(userId, params.loginId);

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return routeError("aws.sso.cancel", error);
  }
}
