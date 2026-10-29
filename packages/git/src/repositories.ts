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

import { githubRequest } from "./client";

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
