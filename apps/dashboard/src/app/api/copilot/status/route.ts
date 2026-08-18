import { NextResponse } from "next/server";

import { fetchCopilotPlan } from "@/lib/agent/copilot-plan";
import {
  getCurrentUserId,
  getUserGithubToken,
} from "@/lib/auth/server-helpers";

export async function GET() {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const gitHubToken = await getUserGithubToken();

  return NextResponse.json({
    githubLinked: Boolean(gitHubToken),
    // Quota is a nice-to-have next to the link status, so it never decides the
    // response: an unreachable GitHub just means no numbers.
    plan: gitHubToken
      ? await fetchCopilotPlan(gitHubToken).catch(() => null)
      : null,
  });
}
