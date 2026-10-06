import { listUserInstallations } from "@terrablox/git/installations";
import { NextResponse } from "next/server";
import { routeError } from "@/lib/api/route-error";
import {
  getCurrentUserId,
  getUserGithubToken,
} from "@/lib/auth/server-helpers";
import { githubAppInstallUrl, githubInstallRequest } from "@/lib/github/app";

// Reads the session from request headers and the app slug from the runtime
// environment, so it must not be prerendered into a static response at build time.
// Without this the build reports a "Dynamic server usage" failure for this route —
// the app still works, because the route falls back to dynamic at request time, but
// the build log carries an error nobody should have to learn to ignore.
export const dynamic = "force-dynamic";

/**
 * Where Terrablox has been granted access, for the account screen to show.
 *
 * This replaces what that screen used to report. Under the OAuth App it listed the
 * granted *scopes*, which was the right answer then and is meaningless now: a
 * GitHub App's user token carries no scopes, so the old panel would have shown an
 * empty list and warned forever about scopes that cannot be granted.
 *
 * Installations are the equivalent question, and a better one — scopes said what
 * Terrablox could do in the abstract, installations say which repositories it can
 * do it to.
 *
 * An empty list is a valid answer, not an error: signed in but nothing granted yet
 * is exactly the state the install link exists for.
 */
export async function GET() {
  try {
    const userId = await getCurrentUserId();
    const token = await getUserGithubToken();

    if (!userId || !token) {
      return NextResponse.json(
        { error: "GitHub is not connected" },
        { status: 401 },
      );
    }

    const installations = await listUserInstallations(token);

    return NextResponse.json({
      installations: installations.map((installation) => ({
        login: installation.account.login,
        type: installation.account.type,
        repositorySelection: installation.repositorySelection,
      })),
      installUrl: githubAppInstallUrl(),
      // Null unless this person is waiting on an organisation owner. An empty
      // installation list has two very different causes — never asked, and asked but
      // not yet approved — and only this tells them apart.
      pendingRequestAt: await githubInstallRequest(
        userId,
        installations.length > 0,
      ),
    });
  } catch (error) {
    return routeError("github/installations", error);
  }
}
