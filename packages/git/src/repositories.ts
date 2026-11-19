/**
 * Repositories as whole things: describing one.
 *
 * Separate from `./files` because the questions differ in kind. These are about a
 * repository's identity; that module is about what is inside it.
 *
 * Creating a repository used to live here too, together with the owner listing and
 * the check that a new repository would land inside the installation's grant. All of
 * it is gone with the Administration permission it needed: Terrablox now binds a
 * repository somebody created on GitHub and granted to the app, which is a decision
 * an organisation can review rather than one the app makes on its own. Nothing in
 * this package asks GitHub to create, delete or reconfigure a repository any more.
 */

import { GithubRequestError, githubRequest } from "./client";

export interface RepoSummary {
  fullName: string;
  htmlUrl: string;
  defaultBranch: string;
  private: boolean;
  description: string | null;
}

interface RepoResponse {
  full_name: string;
  html_url: string;
  default_branch: string;
  private: boolean;
  description: string | null;
}

function toSummary(repo: RepoResponse): RepoSummary {
  return {
    fullName: repo.full_name,
    htmlUrl: repo.html_url,
    defaultBranch: repo.default_branch,
    private: repo.private,
    description: repo.description,
  };
}

export async function getRepository(
  token: string,
  repoFullName: string,
): Promise<RepoSummary> {
  const res = await githubRequest(token, `/repos/${repoFullName}`);
  return toSummary((await res.json()) as RepoResponse);
}

/**
 * Whether GitHub explicitly reports that this repository has no commits.
 *
 * Only the documented 409 body counts. A missing ref, narrowed installation
 * grant or unrelated conflict must not be turned into permission to write the
 * first commit.
 */
export async function repositoryIsEmpty(
  token: string,
  repoFullName: string,
): Promise<boolean> {
  try {
    await githubRequest(token, `/repos/${repoFullName}/commits?per_page=1`);
    return false;
  } catch (error) {
    if (!(error instanceof GithubRequestError) || error.status !== 409) {
      throw error;
    }

    try {
      const body = JSON.parse(error.responseBody ?? "") as {
        message?: unknown;
      };
      if (body.message === "Git Repository is empty.") return true;
    } catch {
      // The status alone is not proof of an empty repository.
    }
    throw error;
  }
}
