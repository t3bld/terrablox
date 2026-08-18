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
    const branches = await githubProvider.getBranches(token, repoFullName);
    return NextResponse.json({ branches });
  } catch (error) {
    return routeError("git-provider/branches", error);
  }
}
