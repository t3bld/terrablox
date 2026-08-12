import { NextResponse } from "next/server";

import { getCurrentUserId } from "@/lib/auth/server-helpers";
import { awsRouteError } from "@/lib/aws/route-error";
import {
  cancelSsoLogin,
  checkSsoLogin,
  completeSsoLogin,
} from "@/lib/aws/sso-service";

/** Polled by the browser while the user approves in the AWS portal. */
export async function GET(
  _req: Request,
  { params }: { params: { loginId: string } },
) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const status = await checkSsoLogin(userId, params.loginId);
    if (!status) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json(status);
  } catch (error) {
    return awsRouteError(error);
  }
}

/** Picks the account, creates the role there, and connects it. */
export async function POST(
  req: Request,
  { params }: { params: { loginId: string } },
) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const input = body as Partial<
    Record<"accountId" | "roleName" | "region" | "label", unknown>
  >;

  if (
    typeof input.accountId !== "string" ||
    typeof input.roleName !== "string"
  ) {
    return NextResponse.json(
      { error: "accountId and roleName are required" },
      { status: 400 },
    );
  }

  try {
    const connection = await completeSsoLogin(userId, params.loginId, {
      accountId: input.accountId,
      roleName: input.roleName,
      region: typeof input.region === "string" ? input.region : "eu-central-1",
      label: typeof input.label === "string" ? input.label : "",
    });

    if (!connection) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ connection }, { status: 201 });
  } catch (error) {
    return awsRouteError(error);
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: { loginId: string } },
) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await cancelSsoLogin(userId, params.loginId);

  return new NextResponse(null, { status: 204 });
}
