import { NextResponse } from "next/server";

import { getCurrentUserId } from "@/lib/auth/server-helpers";
import { awsRouteError } from "@/lib/aws/route-error";
import { purgeStaleLogins, startSsoLogin } from "@/lib/aws/sso-service";

export async function POST(req: Request) {
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

  const input = body as Partial<Record<"startUrl" | "ssoRegion", unknown>>;

  if (
    typeof input.startUrl !== "string" ||
    typeof input.ssoRegion !== "string"
  ) {
    return NextResponse.json(
      { error: "startUrl and ssoRegion are required" },
      { status: 400 },
    );
  }

  try {
    await purgeStaleLogins();

    const login = await startSsoLogin(userId, {
      startUrl: input.startUrl,
      ssoRegion: input.ssoRegion,
    });

    return NextResponse.json({ login }, { status: 201 });
  } catch (error) {
    return awsRouteError(error);
  }
}
