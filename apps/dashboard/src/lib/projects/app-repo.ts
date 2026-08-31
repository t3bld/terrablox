/**
 * The application repository a project builds infrastructure for.
 *
 * Read-only to TerraBlox: nothing is ever committed there, and it is not the
 * project's source of truth — `repoFullName` stays that. It exists so the agent
 * can look at how an application is actually built before proposing what it
 * needs to run, instead of asking someone to describe their own codebase.
 *
 * Shared by the create endpoint and the one that changes the link later, so a
 * project created before this feature existed can still be linked and both paths
 * agree on what a valid link is.
 */

import { GithubRequestError, getRepository } from "@/lib/github/repo-files";

export interface AppRepoLink {
  appRepoFullName: string;
  appRepoBranch: string | null;
}

/** What clients send: `null` for either field clears the link. */
export interface AppRepoInput {
  fullName?: string | null;
  branch?: string | null;
}

export class AppRepoInputError extends Error {}

/**
 * GitHub's own shape for a repository, and the only one its API accepts.
 *
 * Checked rather than trusted because the value is a path segment in every
 * request built from it. A `..` or a slash too many would otherwise address a
 * different endpoint than the one intended.
 */
const FULL_NAME = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** Refs may hold slashes (`release/1.2`) but none of the shell-ish characters. */
const BRANCH = /^[A-Za-z0-9._\-/]+$/;

/**
 * Reads a link off a request body.
 *
 * Three outcomes, and they are deliberately distinct: `undefined` means the
 * client said nothing and an existing link must be left alone, `null` means it
 * asked for the link to be cleared, and a link means it named a repository.
 * Collapsing the first two would make every unrelated update unlink the
 * application.
 */
export function parseAppRepoInput(
  raw: unknown,
): AppRepoLink | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;

  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppRepoInputError("Invalid application repository");
  }

  const input = raw as AppRepoInput;
  const fullName = input.fullName?.trim();

  // An object with no name is how the picker reports "cleared", since it hands
  // back the same shape it was given.
  if (!fullName) return null;

  if (!FULL_NAME.test(fullName)) {
    throw new AppRepoInputError(
      "An application repository is written as owner/name",
    );
  }

  const branch = input.branch?.trim();
  if (branch && !BRANCH.test(branch)) {
    throw new AppRepoInputError("Invalid branch name");
  }

  return { appRepoFullName: fullName, appRepoBranch: branch || null };
}

/** The columns to write, for either a link or the absence of one. */
export function appRepoColumns(link: AppRepoLink | null): {
  appRepoFullName: string | null;
  appRepoBranch: string | null;
} {
  return {
    appRepoFullName: link?.appRepoFullName ?? null,
    appRepoBranch: link?.appRepoBranch ?? null,
  };
}

/**
 * Confirms the credential that will read this repository can actually reach it.
 *
 * The shape check above says the value is addressable, not that it exists. Both
 * write paths accept an arbitrary `owner/name`, and the picker is the only reason
 * a stored link is usually real — so a link set through the API, a repository
 * renamed afterwards, or access that no longer covers it all became a link that
 * looked fine on the settings screen and failed in the middle of a turn, several
 * minutes and one confusing message later.
 *
 * Probed with the *provider* token, which is the credential the agent reads with.
 * Verifying with a different identity than the one that will do the reading would
 * be theatre.
 */
export async function verifyAppRepoAccess(
  token: string,
  link: AppRepoLink,
): Promise<AppRepoLink> {
  let repository: Awaited<ReturnType<typeof getRepository>>;

  try {
    repository = await getRepository(token, link.appRepoFullName);
  } catch (error) {
    if (error instanceof GithubRequestError && error.status === 404) {
      throw new AppRepoInputError(
        `${link.appRepoFullName} cannot be read with your GitHub access. Check the name, or that the repository is one your account can see.`,
      );
    }
    if (
      error instanceof GithubRequestError &&
      (error.status === 401 || error.status === 403)
    ) {
      throw new AppRepoInputError(
        `Not permitted to read ${link.appRepoFullName}. Check the GitHub access you granted.`,
      );
    }

    throw new AppRepoInputError(
      `Could not reach ${link.appRepoFullName} on GitHub. Try again in a moment.`,
    );
  }

  // A branch is stored only when it was deliberately chosen. Left absent, reads
  // resolve the repository's default at the time they happen — which is what
  // keeps a link working after somebody renames `master` to `main`.
  return {
    appRepoFullName: repository.fullName,
    appRepoBranch:
      link.appRepoBranch && link.appRepoBranch !== repository.defaultBranch
        ? link.appRepoBranch
        : null,
  };
}
