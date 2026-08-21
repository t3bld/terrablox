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
