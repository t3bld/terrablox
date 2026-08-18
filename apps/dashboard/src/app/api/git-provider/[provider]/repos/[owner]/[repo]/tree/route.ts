import { githubProvider } from "@terrablox/git-import/github";
import { NextResponse } from "next/server";

import { routeError } from "@/lib/api/route-error";
import {
  requireQueryParam,
  resolveRepoRequest,
} from "@/lib/git-provider/request";

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
