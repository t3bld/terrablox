import { NextResponse } from "next/server";

import {
  COPILOT_MODEL,
  COPILOT_REASONING_EFFORT,
  copilotClient,
} from "@/lib/agent/copilot";
import { getCurrentUserId } from "@/lib/auth/server-helpers";

/**
 * The models the runtime reports, with the efforts each one accepts.
 *
 * The shared client deliberately holds no GitHub token — identity travels on
 * the session — so this can legitimately come back empty. The UI treats an
 * empty list as "ask the user to type an id", not as "there are no models".
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

  try {
    const models = await copilotClient().listModels();

    return NextResponse.json({
      defaults,
      models: models
        .filter((model) => model.policy?.state !== "disabled")
        .map((model) => ({
          id: model.id,
          name: model.name,
          reasoningEfforts: model.supportedReasoningEfforts ?? [],
          multiplier: model.billing?.multiplier ?? null,
        })),
    });
  } catch (error) {
    // Not an error the user caused or can fix, so the page degrades instead.
    console.error("[agent] could not list models", error);
    return NextResponse.json({ defaults, models: [] });
  }
}
