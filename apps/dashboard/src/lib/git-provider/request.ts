import type { GitProviderId } from "@terrablox/git-import";

import { ApiError } from "@/lib/api/route-error";
import { getProviderTokenForRequest } from "@/lib/auth/server-helpers";

/**
 * Resolves the provider token for a repo-scoped route.
 *
 * `getProviderTokenForRequest` returns null without a session, so this doubles
 * as the authentication check - which is why every git-provider route must go
 * through it rather than reaching for the token directly.
 */
export async function resolveProviderRequest(
  req: Request,
  provider: string,
): Promise<string> {
  if (provider !== "github") {
    throw new ApiError("Unsupported provider", 400);
  }

  const token = await getProviderTokenForRequest(
    req,
    provider as GitProviderId,
  );
  if (!token) {
    throw new ApiError("Missing or invalid provider token", 401);
  }

  return token;
}

export async function resolveRepoRequest(
  req: Request,
  params: { provider: string; owner: string; repo: string },
): Promise<{ token: string; repoFullName: string }> {
  const token = await resolveProviderRequest(req, params.provider);

  const owner = params.owner?.trim();
  const repo = params.repo?.trim();
  if (!owner || !repo) {
    throw new ApiError("Missing owner/repo", 400);
  }

  return { token, repoFullName: `${owner}/${repo}` };
}

export function requireQueryParam(req: Request, name: string): string {
  const value = new URL(req.url).searchParams.get(name)?.trim();
  if (!value) {
    throw new ApiError(`Missing ${name}`, 400);
  }
  return value;
}
