import { NextResponse } from "next/server";
import { isGithubConfigured } from "@/lib/auth/server";
import {
  getCurrentUserId,
  getUserGithubToken,
} from "@/lib/auth/server-helpers";

/**
 * Which of the user's own accounts are connected.
 *
 * GitHub only, which is why this reads as a list of one. AWS is deliberately
 * absent: it used to be reported here, and a screen gating on "this user has some
 * AWS connection" would unlock a project that had no account of its own — then
 * fail on the first read. Whether AWS is reachable is a question about a project,
 * and `/api/projects/[projectId]/aws` is where it is asked. Infracost was the
 * other entry until the cost feature was taken out.
 */
export async function GET() {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // A live check, not a lookup of the linked account. Revoking the grant on
  // GitHub leaves the link row in place while every request made with it fails,
  // and that is exactly the state a user needs to be told about.
  const githubToken = await getUserGithubToken();

  return NextResponse.json({
    github: {
      /** False on a server with no GitHub credentials, where nothing can be linked. */
      configured: isGithubConfigured,
      connected: githubToken !== null,
    },
  });
}
