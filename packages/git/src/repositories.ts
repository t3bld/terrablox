/**
 * Repositories as whole things: describing one, listing where a new one may go, and
 * creating it.
 *
 * Separate from `./files` because the questions differ in kind. These are about a
 * repository's identity and where it may exist; that module is about what is inside it.
 */

import { githubRequest } from "./client";
import {
  type GitAppInstallation,
  listUserInstallations,
  type RepositorySelection,
} from "./installations";

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
 * Where a new repository can be created.
 *
 * `login` is the account name and `personal` marks the user's own namespace,
 * which matters because {@link createRepository} distinguishes them by *absence*
 * of an owner — posting a personal login to `/orgs/{login}/repos` is a 404.
 */
export interface RepoOwner {
  login: string;
  personal: boolean;
  /**
   * How much of this account the installation covers.
   *
   * Carried up to the caller because it decides whether creating a repository here
   * is worth attempting: on `selected`, the new repository lands outside the grant
   * and Terrablox cannot write the Terraform it was created to hold. The caller
   * says so before creating anything rather than leaving an unusable repository
   * behind. See `verifyOwnerCanHoldNewRepo`.
   */
  repositorySelection: RepositorySelection;
  /** The installation this owner came from, for building a "manage access" link. */
  installationId: number;
}

/**
 * The owners this user may create a repository under.
 *
 * Derived from the app's installations rather than from `/user/orgs`, and that is a
 * narrowing: an organisation the user belongs to but has not installed Terrablox on
 * is no longer offered. It cannot be — the app has no access there, so a repository
 * created in it would be unreachable the moment it existed. Under the old OAuth App
 * this list came from the user's org memberships and the create call decided, which
 * meant the failure arrived after the side effect.
 *
 * The personal account is sorted first because it is the default choice, then
 * organisations alphabetically.
 */
export async function listRepoOwners(token: string): Promise<RepoOwner[]> {
  const [user, installations] = await Promise.all([
    githubRequest(token, "/user")
      .then((res) => res.json() as Promise<{ login?: string }>)
      .catch(() => null),
    listUserInstallations(token).catch(() => [] as GitAppInstallation[]),
  ]);

  const ownLogin = user?.login?.toLowerCase() ?? null;

  const owners: RepoOwner[] = installations.map((installation) => ({
    login: installation.account.login,
    personal: installation.account.login.toLowerCase() === ownLogin,
    repositorySelection: installation.repositorySelection,
    installationId: installation.id,
  }));

  return owners.sort((a, b) => {
    if (a.personal !== b.personal) return a.personal ? -1 : 1;
    return a.login.localeCompare(b.login);
  });
}

/** Raised when a repository could be created but not then used. */
export class RepoOwnerNotWritableError extends Error {
  readonly login: string;
  readonly installationId: number;

  // Assigned rather than declared as constructor parameter properties, matching
  // GithubRequestError: the seed scripts load this tree through Node's strip-only
  // TypeScript loader, which rejects them.
  constructor(message: string, login: string, installationId: number) {
    super(message);
    this.login = login;
    this.installationId = installationId;
    this.name = "RepoOwnerNotWritableError";
  }
}

/**
 * Checks that a repository created under `owner` would be reachable afterwards.
 *
 * Runs *before* {@link createRepository} on purpose. GitHub will happily create a
 * repository outside the installation's grant, and the failure then surfaces at the
 * first write — by which point there is an empty repository on GitHub belonging to
 * a project that was never stored. This turns that into a refusal with something
 * the user can act on.
 *
 * An owner that is not in the list at all is also refused: it means the app is not
 * installed there, so nothing about the create call would work.
 */
export async function verifyOwnerCanHoldNewRepo(
  token: string,
  owner: string | null,
): Promise<void> {
  const owners = await listRepoOwners(token);

  const target = owner?.trim()
    ? owners.find((o) => o.login.toLowerCase() === owner.trim().toLowerCase())
    : owners.find((o) => o.personal);

  if (!target) {
    throw new RepoOwnerNotWritableError(
      owner?.trim()
        ? `Terrablox is not installed on ${owner.trim()}. Install it there, then try again.`
        : "Terrablox is not installed on your personal account. Install it, then try again.",
      owner?.trim() ?? "",
      0,
    );
  }

  if (target.repositorySelection === "selected") {
    throw new RepoOwnerNotWritableError(
      `Terrablox is installed on ${target.login} for selected repositories only, so a repository created now would be outside its access. Either grant it access to all repositories, or create the repository on GitHub and add it to the installation first.`,
      target.login,
      target.installationId,
    );
  }
}

/**
 * Creates a repository, in an organisation when `owner` names one.
 *
 * The two endpoints are not interchangeable: the personal one always creates
 * under the token's own account, so it is used only when no owner was given.
 */
export async function createRepository(
  token: string,
  input: {
    name: string;
    owner?: string | null;
    description?: string | null;
    private?: boolean;
  },
): Promise<RepoSummary> {
  const owner = input.owner?.trim();
  const path = owner ? `/orgs/${owner}/repos` : "/user/repos";

  const res = await githubRequest(token, path, {
    method: "POST",
    body: JSON.stringify({
      name: input.name,
      description: input.description ?? undefined,
      private: input.private ?? true,
      // Terraform needs at least one commit before contents can be written.
      auto_init: true,
    }),
    headers: { "Content-Type": "application/json" },
  });

  return toSummary((await res.json()) as RepoResponse);
}
