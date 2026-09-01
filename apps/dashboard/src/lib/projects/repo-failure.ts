import "server-only";

import type { Project } from "@terrablox/database";

import { GithubRequestError, getRepository } from "@/lib/github/repo-files";

/**
 * Turns a failed read of a project's own repository into a sentence a user can
 * act on.
 *
 * Without this the surface reads `GitHub API 404 Not Found: {"message":"Not
 * Found","documentation_url":"…/commits#get-a-commit"}` — true, and useless. The
 * document it names is a *commit* lookup, so the raw error also points at the
 * wrong thing: the branch's head is simply the first request that touches the
 * repository, and it fails identically whether the repository is gone, the
 * branch is gone, or the token's access to it was withdrawn.
 *
 * Those three have different fixes, so a 404 is worth one extra request to tell
 * them apart. It is spent only on a path that is already broken, and it buys the
 * difference between "re-point this project" and "change its branch".
 */
export async function describeRepoFailure(
  token: string,
  project: Pick<Project, "repoFullName" | "repoBranch">,
  error: unknown,
): Promise<string> {
  const repo = project.repoFullName;

  if (!(error instanceof GithubRequestError)) {
    return error instanceof Error
      ? error.message
      : `Could not read ${repo} from GitHub.`;
  }

  if (error.status === 401 || error.status === 403) {
    return `GitHub refused access to ${repo}. Reconnect GitHub, or check that the access it was granted still covers this repository.`;
  }

  // 404 and 422 both land here, which is why the probe below exists rather than
  // a status table. Measured against the real API: a repository that is gone
  // answers 404, while a repository that is fine with a ref that is not answers
  // 422 ("No commit found for SHA"). Our own code raises a third 404 for a branch
  // with no commits. Reading the cause off the number alone would be wrong at
  // least once, so the number is only used to decide that it is worth asking.
  if (error.status !== 404 && error.status !== 422) return error.message;

  // Asking about the repository itself separates "it is gone" from "the branch
  // is gone". A failure here is not reported: the question was only ever a
  // refinement, and replacing one error with a second explains nothing.
  let repositoryExists: boolean;
  try {
    await getRepository(token, repo);
    repositoryExists = true;
  } catch {
    repositoryExists = false;
  }

  if (repositoryExists) {
    return `Branch ${project.repoBranch} no longer exists in ${repo}. Point the project at a branch that does, or restore it on GitHub.`;
  }

  return `${repo} is no longer readable on GitHub — it was deleted, renamed, or is no longer covered by the access TerraBlox was granted. The Terraform in it cannot be loaded. The project's log is kept here, and the project itself can still be deleted.`;
}
