import { listRepoOwners } from "@terrablox/git/repositories";
import { NextResponse } from "next/server";
import { resolveProviderRequest } from "@/lib/api/git-request";
import { routeError } from "@/lib/api/route-error";
import { getCurrentUserId } from "@/lib/auth/server-helpers";
import { githubAppInstallUrl, githubInstallRequest } from "@/lib/github/app";

/**
 * The accounts a new repository can be created under.
 *
 * Its own route rather than a field on `/repos`: that one lists repositories that
 * already exist, which is a different question from where a new one may go.
 *
 * Since the move to a GitHub App the answer is narrower and more honest. It used to
 * be the user's organisation memberships, and whether a repository could actually be
 * created there was decided by the create call — after the side effect. Now it is
 * the accounts Terrablox is installed on, which is the same set the repository would
 * have to be usable in afterwards.
 *
 * An empty list is a usable answer and never an error, but it does mean "install the
 * app somewhere first", so `installUrl` travels with it.
 */
export async function GET(
  req: Request,
  { params }: { params: { provider: string } },
) {
  try {
    const token = await resolveProviderRequest(req, params.provider);
    const userId = await getCurrentUserId();

    const owners = await listRepoOwners(token);

    return NextResponse.json({
      owners,
      installUrl: githubAppInstallUrl(),
      // So an empty list can say *why* it is empty. Without this the hint reads
      // "Terrablox is not installed on GitHub yet", which sends somebody who has
      // already asked an organisation owner straight back to ask again.
      pendingRequestAt: userId
        ? await githubInstallRequest(userId, owners.length > 0)
        : null,
    });
  } catch (error) {
    return routeError("git-provider/owners", error);
  }
}
