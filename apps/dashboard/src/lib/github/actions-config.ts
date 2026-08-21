import "server-only";

import { GithubRequestError, githubFetch } from "./repo-files";

/**
 * Reading and writing the repository variables the generated workflows use.
 *
 * The names live in `lib/projects/deploy.ts` next to the YAML that reads them,
 * so a rename cannot drift apart from the pipeline. This module only knows how
 * to get them in and out of GitHub.
 */

/** GitHub only accepts uppercase, digits and underscores, not starting with a digit. */
const VARIABLE_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

export async function getRepoVariable(
  token: string,
  params: { repoFullName: string; name: string },
): Promise<string | null> {
  try {
    const res = await githubFetch(
      token,
      `/repos/${params.repoFullName}/actions/variables/${params.name}`,
    );
    const body = (await res.json()) as { value?: string };
    return body.value ?? null;
  } catch (error) {
    // "Not set" is the normal state before the first run, not a failure.
    if (error instanceof GithubRequestError && error.status === 404)
      return null;
    throw error;
  }
}

/**
 * Sets a repository variable, creating it when it does not exist yet.
 *
 * GitHub has no upsert here: POST fails on an existing name and PATCH fails on
 * a missing one, so the create-then-update dance belongs in one place rather
 * than in every caller.
 */
export async function setRepoVariable(
  token: string,
  params: { repoFullName: string; name: string; value: string },
): Promise<void> {
  if (!VARIABLE_NAME_PATTERN.test(params.name)) {
    throw new GithubRequestError(
      `"${params.name}" is not a valid Actions variable name.`,
      422,
    );
  }

  const body = JSON.stringify({ name: params.name, value: params.value });
  const headers = { "Content-Type": "application/json" };

  try {
    await githubFetch(
      token,
      `/repos/${params.repoFullName}/actions/variables`,
      { method: "POST", body, headers },
    );
  } catch (error) {
    const exists =
      error instanceof GithubRequestError &&
      (error.status === 409 || error.status === 422);
    if (!exists) throw error;

    await githubFetch(
      token,
      `/repos/${params.repoFullName}/actions/variables/${params.name}`,
      { method: "PATCH", body, headers },
    );
  }
}
