import { githubProvider } from "@terrablox/git/github-provider";
import { NextResponse } from "next/server";
import { requireQueryParam, resolveRepoRequest } from "@/lib/api/git-request";
import { routeError } from "@/lib/api/route-error";

export async function GET(
  req: Request,
  { params }: { params: { provider: string; owner: string; repo: string } },
) {
  try {
    const { token, repoFullName } = await resolveRepoRequest(req, params);
    const ref = requireQueryParam(req, "ref");
    const entries = await githubProvider.getTree(token, repoFullName, ref);
    return NextResponse.json({ entries });
  } catch (error) {
    return routeError("git-provider/tree", error);
  }
}
