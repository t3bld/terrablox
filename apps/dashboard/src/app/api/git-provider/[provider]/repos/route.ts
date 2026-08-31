import { githubProvider } from "@terrablox/git-import/github";
import { NextResponse } from "next/server";

import { routeError } from "@/lib/api/route-error";
import { resolveProviderRequest } from "@/lib/git-provider/request";

export async function GET(
  req: Request,
  { params }: { params: { provider: string } },
) {
  try {
    const token = await resolveProviderRequest(req, params.provider);
    const repos = await githubProvider.getRepos(token);
    return NextResponse.json({ repos });
  } catch (error) {
    return routeError("git-provider/repos", error);
  }
}
