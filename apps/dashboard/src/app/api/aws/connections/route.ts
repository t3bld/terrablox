import { NextResponse } from "next/server";

import { getCurrentUserId } from "@/lib/auth/server-helpers";
import {
  createConnection,
  listConnections,
} from "@/lib/aws/connection-service";
import { awsRouteError } from "@/lib/aws/route-error";

export async function GET() {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json(await listConnections(userId));
}

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

  const input = body as Partial<
    Record<"label" | "roleArn" | "region", unknown>
  >;

  if (typeof input.roleArn !== "string") {
    return NextResponse.json({ error: "roleArn is required" }, { status: 400 });
  }

  try {
    const connection = await createConnection(userId, {
      label: typeof input.label === "string" ? input.label : "",
      roleArn: input.roleArn,
      region: typeof input.region === "string" ? input.region : "eu-central-1",
    });

    return NextResponse.json({ connection }, { status: 201 });
  } catch (error) {
    return awsRouteError(error);
  }
}
