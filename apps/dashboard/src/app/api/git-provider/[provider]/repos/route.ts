import { githubProvider } from "@terrablox/git/github-provider";
import { listUserInstallations } from "@terrablox/git/installations";
import { NextResponse } from "next/server";
import { resolveProviderRequest } from "@/lib/api/git-request";
import { routeError } from "@/lib/api/route-error";
import { getCurrentUserId } from "@/lib/auth/server-helpers";
import { githubAppInstallUrl, githubInstallRequest } from "@/lib/github/app";

/**
 * The repositories Terrablox may use, plus why the list is empty when it is.
 *
 * `installed` is the field that earns this route its shape. Since Terrablox became
 * a GitHub App, an empty list has two very different causes: the app is not
 * installed anywhere, or it is installed and was granted nothing useful. Both used
 * to be impossible — an OAuth token saw every repository its owner did — and a
 * picker that just says "no repositories" for either is a dead end, because the fix
 * lives on GitHub rather than in this app.
 */
export async function GET(
  req: Request,
  { params }: { params: { provider: string } },
) {
  try {
    const token = await resolveProviderRequest(req, params.provider);
    const userId = await getCurrentUserId();

    const [repos, installations] = await Promise.all([
      githubProvider.getRepos(token),
      listUserInstallations(token).catch(() => []),
    ]);

    const installed = installations.length > 0;

    return NextResponse.json({
      repos,
      installed,
      installUrl: githubAppInstallUrl(),
      // The third cause of an empty list, and the one neither `installed` nor the
      // list itself can express: asked, and waiting on an organisation owner.
      pendingRequestAt: userId
        ? await githubInstallRequest(userId, installed)
        : null,
    });
  } catch (error) {
    return routeError("git-provider/repos", error);
  }
}
