import { NextResponse } from "next/server";

import {
  AgentSettingsError,
  getAgentSettings,
  saveAgentSettings,
} from "@/lib/agent/settings-service";
import { AGENT_SKILLS } from "@/lib/agent/skills";
import { getCurrentUserId } from "@/lib/auth/server-helpers";

/**
 * The user's own agent settings, plus the catalogue they can choose from.
 *
 * Catalogue and selection travel together because the UI cannot render one
 * without the other, and shipping them separately would let the page show
 * checkboxes for skills that no longer exist.
 */
export async function GET() {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await getAgentSettings(userId);

  return NextResponse.json({
    ...settings,
    // Content is deliberately not sent: it is long, and the description is what
    // a user needs to decide.
    catalogue: AGENT_SKILLS.map(({ id, name, description }) => ({
      id,
      name,
      description,
    })),
  });
}

export async function PUT(request: Request) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { instructions?: unknown; skills?: unknown };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
  }

  const instructions =
    typeof body.instructions === "string" ? body.instructions : "";
  const skills = Array.isArray(body.skills)
    ? body.skills.filter((id): id is string => typeof id === "string")
    : [];

  try {
    await saveAgentSettings(userId, { instructions, skills });
    return NextResponse.json(await getAgentSettings(userId));
  } catch (error) {
    if (error instanceof AgentSettingsError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    // The dev server's log is the only place this is visible, so say enough to
    // be findable there rather than only in the browser.
    console.error("[agent] failed to save settings", error);
    return NextResponse.json(
      { error: "Could not save your settings. Check the server log." },
      { status: 500 },
    );
  }
}
