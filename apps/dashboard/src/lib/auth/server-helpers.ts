import "server-only";

import { headers } from "next/headers";

import { auth, isGithubConfigured } from "@/lib/auth/server";
import {
  getInstallationToken,
  isGithubAppConfigured,
} from "@/lib/github/app-auth";

export type GitAuthMode = "app" | "user" | "none";

/**
 * Which credential the server uses to read repositories.
 *
 * "app"  - GitHub App installation token: one identity for everyone, so every
 *          user sees the same modules regardless of personal repo access.
 * "user" - the signed-in user's OAuth token (needs the `repo` scope).
 */
export function getGitAuthMode(): GitAuthMode {
  if (isGithubAppConfigured) return "app";
  if (isGithubConfigured) return "user";
  return "none";
}

/**
 * Retrieves the Git provider token for the current request (server-side).
 *
 * Prefers the GitHub App installation token. Only when no App is configured
 * does it fall back to the signed-in user's OAuth token, which Better Auth
 * stores on the linked account and refreshes transparently.
 */
export async function getProviderTokenForRequest(
  _req: Request,
  provider: string,
): Promise<string | null> {
  if (provider !== "github") {
    return null;
  }

  if (isGithubAppConfigured) {
    // Still require a session so the App token is never reachable by an
    // unauthenticated caller.
    const userId = await getCurrentUserId();
    if (!userId) {
      return null;
    }

    try {
      return await getInstallationToken();
    } catch (error) {
      console.error(
        "[github-app] Could not obtain an installation token:",
        error,
      );
      return null;
    }
  }

  if (!isGithubConfigured) {
    return null;
  }

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

/**
 * Returns the authenticated user id, or null. Route handlers should use this
 * instead of trusting a client-supplied user id.
 */
export async function getCurrentUserId(): Promise<string | null> {
  const session = await auth.api.getSession({ headers: headers() });
  return session?.user?.id ?? null;
}

/**
 * The signed-in user's own GitHub token, never the App's.
 *
 * Separate from {@link getProviderTokenForRequest} because that one prefers an
 * installation token, which identifies the app rather than a person and so
 * carries nobody's Copilot subscription.
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
    return null;
  }
}
