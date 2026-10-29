import { GithubRequestError, githubRequest } from "./client";

/**
 * Small reads that module library discovery needs on top of the installation
 * listing. All go through the user's own token, so they only ever answer for
 * repositories that person can read.
 */

/** The topics on a repository (Metadata: read). */
export async function getRepositoryTopics(
  token: string,
  repoFullName: string,
): Promise<string[]> {
  const res = await githubRequest(token, `/repos/${repoFullName}/topics`);
  const data = (await res.json()) as { names?: unknown };

  return Array.isArray(data.names)
    ? data.names.filter((name): name is string => typeof name === "string")
    : [];
}

/** The commit a branch points at, or null when the branch does not exist. */
export async function getBranchHeadSha(
  token: string,
  repoFullName: string,
  branch: string,
): Promise<string | null> {
  try {
    const res = await githubRequest(
      token,
      `/repos/${repoFullName}/git/ref/heads/${encodeURIComponent(branch)}`,
    );
    const data = (await res.json()) as { object?: { sha?: string } };
    return data.object?.sha ?? null;
  } catch (error) {
    if (error instanceof GithubRequestError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

async function orgLogins(token: string, path: string): Promise<string[]> {
  try {
    const res = await githubRequest(token, path);
    const data = (await res.json()) as Array<{ login?: unknown }>;
    return Array.isArray(data)
      ? data
          .map((org) => org.login)
          .filter((login): login is string => typeof login === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * Organisations GitHub will admit this user belongs to, as far as a GitHub App
 * user token without the Members permission can tell.
 *
 * The union of `/user/orgs` (may be empty for app tokens) and the user's *public*
 * memberships. A best-effort signal for an install hint, never an access check:
 * it never throws, and a private membership is simply not seen.
 */
export async function listVisibleOrganizationLogins(
  token: string,
): Promise<string[]> {
  let login: string | null = null;

  try {
    const res = await githubRequest(token, "/user");
    const data = (await res.json()) as { login?: unknown };
    login = typeof data.login === "string" ? data.login : null;
  } catch {
    login = null;
  }

  const [own, publicOrgs] = await Promise.all([
    orgLogins(token, "/user/orgs?per_page=100"),
    login
      ? orgLogins(
          token,
          `/users/${encodeURIComponent(login)}/orgs?per_page=100`,
        )
      : Promise.resolve([]),
  ]);

  return [...new Set([...own, ...publicOrgs])];
}
