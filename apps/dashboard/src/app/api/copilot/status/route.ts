import { NextResponse } from "next/server";

import {
  copilotClient,
  describeCopilotError,
  discardCopilotClient,
} from "@/lib/agent/copilot";
import { fetchCopilotPlan } from "@/lib/agent/copilot-plan";
import {
  getCurrentUserId,
  getUserGithubToken,
} from "@/lib/auth/server-helpers";

/**
 * Whether GitHub is linked, plus whatever GitHub will tell us about the
 * licence behind that link. Entitlement itself still only a real request can
 * prove, which is what POST is for.
 */
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

/**
 * Actually runs a turn.
 *
 * Nothing short of a real request proves entitlement: a token that reads
 * repositories fine still fails at Copilot when the account has no seat, and
 * that failure would otherwise show up in the middle of someone's first chat.
 */
export async function POST() {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const gitHubToken = await getUserGithubToken();
  if (!gitHubToken) {
    return NextResponse.json({
      ok: false,
      error: "Link your GitHub account first.",
    });
  }

  const sessionId = `terrablox-check-${userId}-${Date.now()}`;
  const client = copilotClient();

  try {
    const session = await client.createSession({
      sessionId,
      model: "auto",
      gitHubToken,
      availableTools: [],
    });

    try {
      const response = await session.sendAndWait({
        prompt: "Reply with the single word: ready",
      });

      return NextResponse.json({
        ok: true,
        reply: response?.data.content?.trim().slice(0, 200) ?? "",
      });
    } finally {
      await client.deleteSession(session.sessionId).catch(() => {});
    }
  } catch (error) {
    discardCopilotClient(error);
    return NextResponse.json({ ok: false, error: describeCopilotError(error) });
  }
}
