import { NextResponse } from "next/server";

// Container healthcheck and post-deploy probe. Must never require a session.
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ status: "ok" });
}
