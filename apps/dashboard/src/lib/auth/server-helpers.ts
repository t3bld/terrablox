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

  try {
    const { accessToken } = await auth.api.getAccessToken({
      body: { providerId: "github" },
      headers: headers(),
    });

    return accessToken ?? null;
  } catch {
    // Not signed in, or no GitHub account linked to this user.
    return null;
  }
}
