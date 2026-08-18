import { githubProvider } from "@terrablox/git-import/github";
import { NextResponse } from "next/server";

import { routeError } from "@/lib/api/route-error";
import { resolveRepoRequest } from "@/lib/git-provider/request";

export async function GET(
  req: Request,
  { params }: { params: { provider: string; owner: string; repo: string } },
) {
  try {
    const { token, repoFullName } = await resolveRepoRequest(req, params);
    const releases = await githubProvider.getReleases(token, repoFullName);
    return NextResponse.json({ releases });
  } catch (error) {
    return routeError("git-provider/releases", error);
  }
}
