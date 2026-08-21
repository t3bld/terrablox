import { NextResponse } from "next/server";
import { isGithubConfigured } from "@/lib/auth/server";
import {
  getCurrentUserId,
  getUserGithubToken,
} from "@/lib/auth/server-helpers";
import { hasInfracostApiKey } from "@/lib/integrations/infracost";

/**
 * Which of the user's own accounts are connected.
 *
 * AWS is deliberately absent. It used to be reported here, and a screen gating on
 * "this user has some AWS connection" would unlock a project that had no account
 * of its own — then fail on the first read. Whether AWS is reachable is a question
 * about a project, and `/api/projects/[projectId]/aws` is where it is asked.
 */
export async function GET() {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [infracost, githubToken] = await Promise.all([
    hasInfracostApiKey(userId),
    // A live check, not a lookup of the linked account. Revoking the grant on
    // GitHub leaves the link row in place while every request made with it
    // fails, and that is exactly the state a user needs to be told about.
    getUserGithubToken(),
  ]);

  return NextResponse.json({
    infracost: { connected: infracost },
    github: {
      /** False on a server with no GitHub credentials, where nothing can be linked. */
      configured: isGithubConfigured,
      connected: githubToken !== null,
    },
  });
}
