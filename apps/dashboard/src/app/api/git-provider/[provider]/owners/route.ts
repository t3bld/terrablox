import { NextResponse } from "next/server";

import { routeError } from "@/lib/api/route-error";
import { resolveProviderRequest } from "@/lib/git-provider/request";
import { listRepoOwners } from "@/lib/github/repo-files";

/**
 * The accounts a new repository can be created under.
 *
 * Its own route rather than a field on `/repos`: that one lists repositories the
 * user can *read*, which is a different question — a person can read hundreds of
 * repositories in organisations they cannot create anything in.
 *
 * Never fails the caller. An empty list is a usable answer, because a repository
 * created without an owner lands in the personal account, which is the default
 * anyway. Turning a failed lookup into an error would block project creation over
 * a dropdown.
 */
export async function GET(
  req: Request,
  { params }: { params: { provider: string } },
) {
  try {
    const token = await resolveProviderRequest(req, params.provider);
    return NextResponse.json({ owners: await listRepoOwners(token) });
  } catch (error) {
    return routeError("git-provider/owners", error);
  }
}
