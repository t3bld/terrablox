/**
 * Branches and pull requests.
 *
 * Agent mode never writes to a project's own branch: it works on a branch of its
 * own and proposes the result as a pull request, so the person who owns the
 * repository reviews and merges it like any other change.
 */
import { GithubRequestError, githubRequest } from "./client";

export interface PullRequest {
  number: number;
  htmlUrl: string;
  state: string;
}

/**
 * Creates `branch` at `fromSha`.
 *
 * Idempotent: a branch that already exists is left where it is, because the only
 * caller that hits that case is a run being resumed, and moving its branch back
 * to the base would throw away the work it already committed.
 */
export async function createBranch(
  token: string,
  params: { repoFullName: string; branch: string; fromSha: string },
): Promise<void> {
  try {
    await githubRequest(token, `/repos/${params.repoFullName}/git/refs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ref: `refs/heads/${params.branch}`,
        sha: params.fromSha,
      }),
    });
  } catch (error) {
    if (
      error instanceof GithubRequestError &&
      error.status === 422 &&
      /already exists/i.test(error.responseBody ?? error.message)
    ) {
      return;
    }
    throw error;
  }
}

/** The open pull request from `head` into `base`, if there is one. */
export async function findOpenPullRequest(
  token: string,
  params: { repoFullName: string; head: string; base: string },
): Promise<PullRequest | null> {
  const owner = params.repoFullName.split("/")[0] ?? "";
  const query = new URLSearchParams({
    head: `${owner}:${params.head}`,
    base: params.base,
    state: "open",
  });
  const res = await githubRequest(
    token,
    `/repos/${params.repoFullName}/pulls?${query.toString()}`,
  );
  const body = (await res.json()) as Array<{
    number: number;
    html_url: string;
    state: string;
  }>;
  const first = body[0];
  return first
    ? { number: first.number, htmlUrl: first.html_url, state: first.state }
    : null;
}

/**
 * Opens a pull request, or returns the one already open for the same branches.
 *
 * Needs the `pull_requests: write` permission on the installation.
 */
export async function createPullRequest(
  token: string,
  params: {
    repoFullName: string;
    head: string;
    base: string;
    title: string;
    body: string;
  },
): Promise<PullRequest> {
  const existing = await findOpenPullRequest(token, params).catch(() => null);
  if (existing) return existing;

  const res = await githubRequest(
    token,
    `/repos/${params.repoFullName}/pulls`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: params.title,
        head: params.head,
        base: params.base,
        body: params.body,
      }),
    },
  );
  const body = (await res.json()) as {
    number: number;
    html_url: string;
    state: string;
  };
  return { number: body.number, htmlUrl: body.html_url, state: body.state };
}
