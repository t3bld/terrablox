/**
 * Where the app has been installed, and what each installation may reach.
 *
 * This is the half of a GitHub App that an OAuth App has no equivalent for, and it
 * is why the migration was worth doing. An OAuth App's token reaches every
 * repository its owner can reach; a GitHub App's user token reaches only the
 * repositories somebody deliberately granted. That set is what these endpoints
 * report, and it is the only honest source for "which repositories can Terrablox
 * actually use" — `/user/repos` answers a different question (what the *person*
 * can see) and would fill a picker with repositories that 404 on first read.
 *
 * Everything here uses the signed-in user's token, not an installation token.
 * Nothing in Terrablox runs without a user, so the app never needs to act as
 * itself, and that keeps the private key out of the deployment entirely.
 */

import { githubRequest } from "./client";
import type { GitRepo } from "./types";

const PER_PAGE = 100;

/**
 * Pages to walk before giving up.
 *
 * A stop condition rather than a limit anyone should hit: at 100 per page this is
 * ten thousand repositories in one installation. It exists so a bug in the
 * termination check cannot turn into an unbounded loop against a rate-limited API.
 */
const MAX_PAGES = 10;

/**
 * How much of an account's repositories an installation was granted.
 *
 * Worth carrying rather than discarding, because it decides whether a repository
 * Terrablox is about to *create* will be reachable afterwards. On `selected`, a new
 * repository is outside the grant until somebody adds it.
 */
export type RepositorySelection = "all" | "selected";

export interface GitAppInstallation {
  id: number;
  /** The user or organisation the app was installed on. */
  account: {
    login: string;
    /** `User` for a personal account, `Organization` for an org. */
    type: string;
  };
  repositorySelection: RepositorySelection;
}

interface InstallationsResponse {
  installations?: Array<{
    id: number;
    account?: { login?: string; type?: string } | null;
    repository_selection?: string;
  }>;
}

interface InstallationReposResponse {
  repositories?: GitRepo[];
}

/**
 * The installations the signed-in user can see.
 *
 * Note what this is *not*: a list of everywhere the app is installed. It is scoped
 * to the caller, so a colleague's personal installation never appears here. That is
 * the behaviour we want — a repository picker should offer what this person may use.
 */
export async function listUserInstallations(
  token: string,
): Promise<GitAppInstallation[]> {
  const res = await githubRequest(
    token,
    `/user/installations?per_page=${PER_PAGE}`,
  );
  const data = (await res.json()) as InstallationsResponse;

  const installations: GitAppInstallation[] = [];

  for (const raw of data.installations ?? []) {
    const login = raw.account?.login;
    if (!login) continue;

    installations.push({
      id: raw.id,
      account: { login, type: raw.account?.type ?? "User" },
      // Anything unrecognised is treated as the restrictive case on purpose:
      // assuming `all` would let the project-creation check wave through a
      // repository that then turns out to be unreachable.
      repositorySelection:
        raw.repository_selection === "all" ? "all" : "selected",
    });
  }

  return installations;
}

/** The repositories one installation grants, as far as this user may see them. */
export async function listInstallationRepos(
  token: string,
  installationId: number,
): Promise<GitRepo[]> {
  const repos: GitRepo[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await githubRequest(
      token,
      `/user/installations/${installationId}/repositories?per_page=${PER_PAGE}&page=${page}`,
    );
    const data = (await res.json()) as InstallationReposResponse;
    const batch = data.repositories ?? [];

    repos.push(...batch);

    if (batch.length < PER_PAGE) break;
  }

  return repos;
}

/**
 * Every repository the app may use, across all of this user's installations.
 *
 * Deduplicated by `full_name`: the same repository can arrive twice when someone
 * has the app installed both personally and on an organisation that the repository
 * was transferred between.
 *
 * A failing installation is skipped rather than fatal. Installations are
 * independent grants, and one organisation revoking access mid-request should not
 * empty the picker for the other three.
 */
export async function listAccessibleRepos(token: string): Promise<GitRepo[]> {
  const installations = await listUserInstallations(token);

  const perInstallation = await Promise.all(
    installations.map((installation) =>
      listInstallationRepos(token, installation.id).catch(
        () => [] as GitRepo[],
      ),
    ),
  );

  const byFullName = new Map<string, GitRepo>();

  for (const repos of perInstallation) {
    for (const repo of repos) {
      if (repo.full_name) byFullName.set(repo.full_name, repo);
    }
  }

  return Array.from(byFullName.values());
}
