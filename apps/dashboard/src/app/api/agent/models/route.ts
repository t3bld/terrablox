import { NextResponse } from "next/server";

import {
  COPILOT_MODEL,
  COPILOT_REASONING_EFFORT,
  listCopilotModels,
} from "@/lib/agent/copilot";
import { FALLBACK_MODELS } from "@/lib/agent/runtime-options";
import {
  getCurrentUserId,
  getUserGithubToken,
} from "@/lib/auth/server-helpers";

/**
 * The models this user may run a turn on, with the efforts each one accepts.
 *
 * Listed with their own GitHub token, because the answer is their Copilot
 * entitlement and nobody else's. When it cannot be listed — no token, no seat, a
 * runtime that will not start — a small known list stands in, so the dropdown
 * offers something real instead of appearing to say there are no models.
 */
export async function GET() {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const defaults = {
    model: COPILOT_MODEL,
    reasoningEffort: COPILOT_REASONING_EFFORT,
  };

  const token = await getUserGithubToken();
  const listed = token ? await listCopilotModels(token) : null;

  return NextResponse.json({
    defaults,
    models: listed && listed.length > 0 ? listed : FALLBACK_MODELS,
    /** False when the list is the fallback, so the UI can say so if it wants. */
    fromRuntime: Boolean(listed && listed.length > 0),
  });
}
