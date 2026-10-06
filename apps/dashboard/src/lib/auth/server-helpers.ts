import "server-only";

import { headers } from "next/headers";

import { auth, isGithubConfigured } from "@/lib/auth/server";

/**
 * Retrieves the Git provider token for the current request (server-side).
 *
 * GitHub is the only provider, and it is read with the signed-in user's own
 * OAuth token, so this is {@link getUserGithubToken} behind a signature that
 * carries the provider — the shape route handlers already speak.
 */
export async function getProviderTokenForRequest(
  _req: Request,
  provider: string,
): Promise<string | null> {
  if (provider !== "github") {
    return null;
  }

  return getUserGithubToken();
}

/**
 * Returns the authenticated user id, or null. Route handlers should use this
 * instead of trusting a client-supplied user id.
 */
export async function getCurrentUserId(): Promise<string | null> {
  const session = await auth.api.getSession({ headers: headers() });
  return session?.user?.id ?? null;
}

/**
 * The signed-in user's GitHub token, which needs the `repo` scope to read
 * private repositories. Better Auth stores it on the linked account and
 * refreshes it transparently.
 */
export async function getUserGithubToken(): Promise<string | null> {
  if (!isGithubConfigured) return null;

  const userId = await getCurrentUserId();
  if (!userId) return null;

  return githubTokenForUser(userId);
}

/**
 * The same token, for a caller that has a user id but no request to read.
 *
 * This is what makes a non-browser client possible at all. Every mutating operation
 * here commits Terraform, which needs the person's GitHub token, and the only path to
 * that token used to go through `headers()` — i.e. through a session cookie. An MCP
 * host has no cookie, so without this there would be nothing for it to do.
 *
 * `getAccessToken` accepts `userId` in its body and resolves the linked account
 * directly, refresh included. Verified against a real account: it returns a `ghu_`
 * user-to-server token with no headers passed at all.
 *
 * The caller is responsible for having established *which* user this is. Handed the
 * wrong id, this hands back the wrong person's credentials — which is why it takes a
 * bare string and lives next to the function that authenticates.
 */
export async function githubTokenForUser(
  userId: string,
): Promise<string | null> {
  if (!isGithubConfigured) return null;

  try {
    const { accessToken } = await auth.api.getAccessToken({
      body: { providerId: "github", userId },
    });

    return accessToken ?? null;
  } catch {
    // No GitHub account linked to this user, or the refresh was refused.
    return null;
  }
}
