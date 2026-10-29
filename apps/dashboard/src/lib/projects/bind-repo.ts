/**
 * Binding a project to a repository that already exists on GitHub.
 *
 * This replaced creating one. Creating needed the GitHub App's *Administration*
 * permission, and that is the permission organisations refuse to grant — it also
 * covers deleting repositories and changing their collaborators. It also could not
 * work on an installation with *Only select repositories*, because a repository the
 * app creates is not part of the selection. Binding needs neither: somebody creates
 * the repository on GitHub and adds it to the installation, and Terrablox only uses
 * what it was given.
 *
 * Adopting an existing repository was removed once before, for a reason this module
 * keeps solved rather than reintroduces: it forced the user to name the folder holding
 * the root Terraform configuration, and a wrong answer gave an empty graph with no
 * explanation. So only repositories with *no* Terraform in them are accepted. That
 * leaves exactly one possible root, the repository root, and nothing to ask.
 *
 * Shared by every path that creates a project, so they all refuse the same things in
 * the same words.
 */

import { GithubRequestError } from "@terrablox/git/client";
import { getBranchHead, listRepoTree } from "@terrablox/git/files";
import { listAccessibleRepos } from "@terrablox/git/installations";
import { getRepository, type RepoSummary } from "@terrablox/git/repositories";

/**
 * A repository that cannot be bound, with a message written for the person who has
 * to fix it.
 *
 * The message is safe to send to the browser as it is: it names only the repository
 * the caller asked about and what to do on GitHub. `status` is the HTTP status the
 * route should answer with — 400 for a repository the caller may not use at all, 409
 * for one they may use but whose current state does not fit.
 */
export class RepoBindError extends Error {
  readonly status: 400 | 409;

  constructor(message: string, status: 400 | 409) {
    super(message);
    this.status = status;
    this.name = "RepoBindError";
  }
}

/** The repository is not among those granted to any of the user's installations. */
export class RepoNotGrantedError extends RepoBindError {
  constructor(message: string) {
    super(message, 400);
    this.name = "RepoNotGrantedError";
  }
}

/** The repository has no commits, or not on the branch that was asked for. */
export class RepoNotInitialisedError extends RepoBindError {
  constructor(message: string) {
    super(message, 409);
    this.name = "RepoNotInitialisedError";
  }
}

/** The repository already holds Terraform, so its root would be a guess. */
export class RepoHasTerraformError extends RepoBindError {
  constructor(message: string) {
    super(message, 409);
    this.name = "RepoHasTerraformError";
  }
}

export interface BoundRepo {
  repo: RepoSummary;
  /** The branch the project will read from and commit to. */
  branch: string;
}

/** How many offending paths to name before "and N more" is the more useful answer. */
const LISTED_TF_FILES = 3;

/**
 * Checks that `repoFullName` can become a project's repository, and says how.
 *
 * Three refusals, in the order a person would fix them:
 *
 *   1. Not granted. Decided from the installation listing and not from
 *      `GET /repos/{repo}`, because a user can *see* repositories the app was never
 *      given — a member of an organisation reads its repositories with their own
 *      access — and the first commit to one of those would fail with a 404 that
 *      reads like a deleted repository.
 *   2. No commits, or no such branch. Commits go through the Git Data API, which
 *      builds on top of an existing branch head; an empty repository has none, and
 *      creating the first commit through that API is not possible.
 *   3. Terraform already present, anywhere in the tree. See the module comment.
 *
 * Anything else GitHub answers — an expired token, a rate limit, an outage — is
 * passed through as the `GithubRequestError` it is, for the route to turn into a
 * response without echoing GitHub's body.
 */
export async function bindExistingRepo(
  token: string,
  repoFullName: string,
  branch?: string | null,
): Promise<BoundRepo> {
  const wanted = repoFullName.trim();

  // Compared case-insensitively because GitHub resolves `Acme/Infra` and
  // `acme/infra` to the same repository; what is stored is GitHub's own spelling.
  const granted = (await listAccessibleRepos(token)).find(
    (repo) => repo.full_name.toLowerCase() === wanted.toLowerCase(),
  );

  if (!granted) {
    throw new RepoNotGrantedError(
      `Terrablox has no access to ${wanted}. Open the Terrablox installation on GitHub ("Change repository access"), add ${wanted} under Repository access, save, then try again.`,
    );
  }

  let repo: RepoSummary;
  try {
    repo = await getRepository(token, granted.full_name);
  } catch (error) {
    // Listed a moment ago and unreadable now: the grant was narrowed in between, or
    // the listing is stale. Either way the fix is the same one as above.
    if (error instanceof GithubRequestError && error.status === 404) {
      throw new RepoNotGrantedError(
        `Terrablox cannot read ${granted.full_name}. Check that it is still selected in the Terrablox installation on GitHub, then try again.`,
      );
    }
    throw error;
  }

  const target = branch?.trim() || repo.defaultBranch;
  const head = await getBranchHead(token, {
    repoFullName: repo.fullName,
    branch: target,
  });

  if (!head) {
    // A repository with any commit has its default branch, so a missing default
    // branch means a repository with nothing in it.
    throw new RepoNotInitialisedError(
      target === repo.defaultBranch
        ? `${repo.fullName} has no commits yet. Terrablox commits on top of an existing branch, so the repository needs a first commit: on GitHub, add a README (or create the repository with "Add a README file" ticked), then try again.`
        : `${repo.fullName} has no branch named ${target}. Create it on GitHub, or leave the branch empty to use ${repo.defaultBranch}. An empty repository needs a first commit too — create it with a README.`,
    );
  }

  const tree = await listRepoTree(token, {
    repoFullName: repo.fullName,
    ref: head,
  });

  const terraform = tree.entries
    .filter((entry) => entry.type === "blob" && entry.path.endsWith(".tf"))
    .map((entry) => entry.path);

  if (terraform.length > 0) {
    const named = terraform.slice(0, LISTED_TF_FILES).join(", ");
    const more = terraform.length - LISTED_TF_FILES;

    throw new RepoHasTerraformError(
      `${repo.fullName} already contains Terraform (${named}${
        more > 0 ? ` and ${more} more` : ""
      }). Terrablox writes a project's Terraform at the repository root and only binds repositories without .tf files, so it never has to guess where existing configuration lives. Choose an empty repository, or create a new one on GitHub with a README.`,
    );
  }

  // A partial listing that happened to contain no `.tf` proves nothing about the
  // rest, and accepting it would bring back exactly the guess this module exists to
  // avoid. A repository this large is not a fresh infrastructure repository anyway.
  if (tree.truncated) {
    throw new RepoHasTerraformError(
      `${repo.fullName} is too large for GitHub to list in one go, so Terrablox cannot confirm it holds no Terraform. Choose an empty repository, or create a new one on GitHub with a README.`,
    );
  }

  return { repo, branch: target };
}
