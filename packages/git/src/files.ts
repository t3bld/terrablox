/**
 * Repository contents: reading a file, committing several as one revision, listing the
 * tree.
 *
 * A project's repository is its source of truth, so the app has to write to it as well
 * as read it. That makes this the one place where a failed request matters: a
 * half-applied change would leave the graph and the repository disagreeing, so every
 * helper here throws with the provider's own message instead of returning null and
 * letting the caller guess.
 */

import { Buffer } from "node:buffer";

import { GithubRequestError, githubRequest } from "./client";

/** Path segments are encoded individually so the slashes survive. */
function encodeRepoPath(path: string): string {
  return path.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
}

export interface RepoFile {
  path: string;
  content: string;
  /** Blob sha, required by GitHub to update or delete the file. */
  sha: string;
}

export async function readRepoFile(
  token: string,
  params: { repoFullName: string; path: string; ref: string },
): Promise<RepoFile | null> {
  const url = `/repos/${params.repoFullName}/contents/${encodeRepoPath(
    params.path,
  )}?ref=${encodeURIComponent(params.ref)}`;

  let res: Response;
  try {
    res = await githubRequest(token, url);
  } catch (error) {
    if (error instanceof GithubRequestError && error.status === 404)
      return null;
    throw error;
  }

  const body = (await res.json()) as {
    type?: string;
    encoding?: string;
    content?: string;
    sha?: string;
  };

  if (body.type !== "file" || !body.sha) return null;
  if (body.encoding !== "base64" || typeof body.content !== "string") {
    return null;
  }

  return {
    path: params.path,
    content: Buffer.from(body.content, "base64").toString("utf8"),
    sha: body.sha,
  };
}

export interface FileChange {
  path: string;
  /** New file contents, or null to delete the file. */
  content: string | null;
}

export interface CommitResult {
  sha: string;
  paths: string[];
}

/**
 * Commits several files as one revision through the Git data API.
 *
 * The contents API can only write one file per commit, and a graph edit
 * routinely touches two: removing a module also removes the arguments that
 * referenced it. Splitting that into two commits would leave the repository in
 * a state that does not plan.
 */
export async function commitFiles(
  token: string,
  params: {
    repoFullName: string;
    branch: string;
    message: string;
    changes: FileChange[];
  },
): Promise<CommitResult | null> {
  if (params.changes.length === 0) return null;

  const repo = params.repoFullName;

  const refRes = await githubRequest(
    token,
    `/repos/${repo}/git/ref/heads/${encodeURIComponent(params.branch)}`,
  );
  const ref = (await refRes.json()) as { object?: { sha?: string } };
  const headSha = ref.object?.sha;
  if (!headSha) {
    throw new GithubRequestError(`Branch ${params.branch} has no commits`, 404);
  }

  const headRes = await githubRequest(
    token,
    `/repos/${repo}/git/commits/${headSha}`,
  );
  const head = (await headRes.json()) as { tree?: { sha?: string } };
  if (!head.tree?.sha) {
    throw new GithubRequestError("Head commit has no tree", 500);
  }

  const paths = params.changes.map((change) => change.path.replace(/^\/+/, ""));

  const treeRes = await createTree(token, repo, {
    base_tree: head.tree.sha,
    tree: params.changes.map((change, index) => ({
      path: paths[index] as string,
      mode: "100644",
      type: "blob",
      // A null sha removes the path from the tree.
      ...(change.content === null
        ? { sha: null }
        : { content: change.content }),
    })),
  }).catch((error: unknown) => {
    throw explainTreeFailure(error, paths);
  });
  const tree = (await treeRes.json()) as { sha?: string };
  if (!tree.sha) throw new GithubRequestError("Tree creation failed", 500);

  const commitRes = await githubRequest(token, `/repos/${repo}/git/commits`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: params.message,
      tree: tree.sha,
      parents: [headSha],
    }),
  });
  const commit = (await commitRes.json()) as { sha?: string };
  if (!commit.sha) throw new GithubRequestError("Commit creation failed", 500);

  await githubRequest(
    token,
    `/repos/${repo}/git/refs/heads/${encodeURIComponent(params.branch)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sha: commit.sha }),
    },
  );

  return { sha: commit.sha, paths: params.changes.map((c) => c.path) };
}

/** The tree POST on its own, so the call and its diagnosis stay separable. */
function createTree(
  token: string,
  repo: string,
  body: unknown,
): Promise<Response> {
  return githubRequest(token, `/repos/${repo}/git/trees`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Turns GitHub's answer to a forbidden workflow write into the sentence it means.
 *
 * A workflow file can read the repository's secrets, so GitHub will not let a token
 * create or update anything under `.github/workflows/` unless it was granted the
 * `workflow` scope — and `repo` does not include it. What comes back is not a
 * message saying so: it is a bare `404 Not Found` on the tree, which reads as "the
 * repository is gone" and sent at least one person looking for a deleted repo.
 *
 * Safe to infer here rather than guess, because of where this sits: the two reads
 * above it — the branch ref and the head commit — have already succeeded against
 * this exact repository, so the repository demonstrably exists and is readable, and
 * a 404 on the write that follows cannot be about its existence. Only a change set
 * that actually touches a workflow path is re-explained; anything else is passed
 * through untouched.
 */
function explainTreeFailure(error: unknown, paths: string[]): unknown {
  const workflows = paths.filter((path) =>
    path.startsWith(".github/workflows/"),
  );

  if (
    !(error instanceof GithubRequestError) ||
    workflows.length === 0 ||
    (error.status !== 404 && error.status !== 403)
  ) {
    return error;
  }

  return new GithubRequestError(
    `GitHub would not write ${workflows.join(", ")}. Changing workflow files needs the "workflow" permission, and this GitHub connection was not granted it — the scopes a connection has are fixed when it is made, so signing out and back in is what grants it. Nothing else about the setup is affected: the role, the state backend and the repository variables are already in place.`,
    error.status,
  );
}

export interface RepoTreeEntry {
  path: string;
  type: "tree" | "blob";
}

export interface RepoTree {
  sha: string;
  entries: RepoTreeEntry[];
  /**
   * GitHub gave up before listing the whole repository.
   *
   * A recursive tree request is capped — roughly 100 000 entries or 7 MB — and
   * past that the API returns `truncated: true` with a *partial* list and a 200.
   * Reporting it is not a nicety: a caller that filters this list and finds
   * nothing cannot otherwise tell "there is no Dockerfile" from "the answer did
   * not fit", and those two conclusions lead somewhere very different.
   */
  truncated: boolean;
}

export async function listRepoTree(
  token: string,
  params: { repoFullName: string; ref: string },
): Promise<RepoTree> {
  const commitRes = await githubRequest(
    token,
    `/repos/${params.repoFullName}/commits/${encodeURIComponent(params.ref)}`,
  );
  const commit = (await commitRes.json()) as { sha?: string };
  if (!commit.sha) {
    throw new GithubRequestError(`Unable to resolve ref ${params.ref}`, 404);
  }

  const treeRes = await githubRequest(
    token,
    `/repos/${params.repoFullName}/git/trees/${commit.sha}?recursive=1`,
  );
  const tree = (await treeRes.json()) as {
    tree?: Array<{ path: string; type: string }>;
    truncated?: boolean;
  };

  const entries = (tree.tree ?? [])
    .filter((e) => e.type === "tree" || e.type === "blob")
    .map((e) => ({ path: e.path, type: e.type as "tree" | "blob" }));

  return { sha: commit.sha, entries, truncated: tree.truncated === true };
}
