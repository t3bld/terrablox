import { githubProvider } from "@terrablox/git/github-provider";
import { NextResponse } from "next/server";
import { resolveRepoRequest } from "@/lib/api/git-request";
import { routeError } from "@/lib/api/route-error";

export async function GET(
  req: Request,
  { params }: { params: { provider: string; owner: string; repo: string } },
) {
  try {
    const { token, repoFullName } = await resolveRepoRequest(req, params);
    const tags = await githubProvider.getTags(token, repoFullName);
    return NextResponse.json({ tags });
  } catch (error) {
    return routeError("git-provider/tags", error);
  }
}
