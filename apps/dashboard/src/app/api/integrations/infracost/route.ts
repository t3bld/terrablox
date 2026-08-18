import { NextResponse } from "next/server";

import { getCurrentUserId } from "@/lib/auth/server-helpers";
import {
  clearInfracostApiKey,
  getInfracostStatus,
  InfracostSettingsError,
  saveInfracostApiKey,
} from "@/lib/integrations/infracost";

/** The key itself is never returned, only whether one is stored. */
export async function GET() {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json(await getInfracostStatus(userId));
}

export async function PUT(request: Request) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { apiKey?: unknown };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
  }

  if (typeof body.apiKey !== "string") {
    return NextResponse.json(
      { error: "Enter your Infracost API key." },
      { status: 400 },
    );
  }

  try {
    await saveInfracostApiKey(userId, body.apiKey);
    return NextResponse.json(await getInfracostStatus(userId));
  } catch (error) {
    if (error instanceof InfracostSettingsError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    console.error("[infracost] failed to save the API key", error);
    return NextResponse.json(
      { error: "Could not save the key. Check the server log." },
      { status: 500 },
    );
  }
}

export async function DELETE() {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await clearInfracostApiKey(userId);
  return NextResponse.json(await getInfracostStatus(userId));
}
