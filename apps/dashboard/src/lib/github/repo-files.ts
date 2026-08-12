import "server-only";

/**
 * Repository reads and writes for projects.
 *
 * A project's repository is its source of truth, so the app has to write to it
 * as well as read it. That makes this the one place where a failed request
 * matters: a half-applied change would leave the graph and the repository
 * disagreeing, so every helper here throws with the provider's own message
 * instead of returning null and letting the caller guess.
 */

const GITHUB_API = "https://api.github.com";
const API_VERSION = "2022-11-28";

export class GithubRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GithubRequestError";
  }
}

async function githubFetch(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new GithubRequestError(
      `GitHub API ${res.status} ${res.statusText}: ${body.slice(0, 300)}`,
      res.status,
    );
  }

  return res;
}

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
  const res = await githubFetch(token, `/repos/${repoFullName}`);
  return toSummary((await res.json()) as RepoResponse);
}

/**
 * Creates a repository, in an organisation when `owner` names one.
 *
 * A GitHub App installation token can only create repositories inside the
 * organisation it is installed in, and only with `Administration: write`. The
 * personal endpoint is therefore attempted only when no owner was given.
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

  const res = await githubFetch(token, path, {
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
    res = await githubFetch(token, url);
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

  const refRes = await githubFetch(
    token,
    `/repos/${repo}/git/ref/heads/${encodeURIComponent(params.branch)}`,
  );
  const ref = (await refRes.json()) as { object?: { sha?: string } };
  const headSha = ref.object?.sha;
  if (!headSha) {
    throw new GithubRequestError(`Branch ${params.branch} has no commits`, 404);
  }

  const headRes = await githubFetch(
    token,
    `/repos/${repo}/git/commits/${headSha}`,
  );
  const head = (await headRes.json()) as { tree?: { sha?: string } };
  if (!head.tree?.sha) {
    throw new GithubRequestError("Head commit has no tree", 500);
  }

  const treeRes = await githubFetch(token, `/repos/${repo}/git/trees`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      base_tree: head.tree.sha,
      tree: params.changes.map((change) => ({
        path: change.path.replace(/^\/+/, ""),
        mode: "100644",
        type: "blob",
        // A null sha removes the path from the tree.
        ...(change.content === null
          ? { sha: null }
          : { content: change.content }),
      })),
    }),
  });
  const tree = (await treeRes.json()) as { sha?: string };
  if (!tree.sha) throw new GithubRequestError("Tree creation failed", 500);

  const commitRes = await githubFetch(token, `/repos/${repo}/git/commits`, {
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

  await githubFetch(
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

export interface RepoTreeEntry {
  path: string;
  type: "tree" | "blob";
}

export async function listRepoTree(
  token: string,
  params: { repoFullName: string; ref: string },
): Promise<{ sha: string; entries: RepoTreeEntry[] }> {
  const commitRes = await githubFetch(
    token,
    `/repos/${params.repoFullName}/commits/${encodeURIComponent(params.ref)}`,
  );
  const commit = (await commitRes.json()) as { sha?: string };
  if (!commit.sha) {
    throw new GithubRequestError(`Unable to resolve ref ${params.ref}`, 404);
  }

  const treeRes = await githubFetch(
    token,
    `/repos/${params.repoFullName}/git/trees/${commit.sha}?recursive=1`,
  );
  const tree = (await treeRes.json()) as {
    tree?: Array<{ path: string; type: string }>;
  };

  const entries = (tree.tree ?? [])
    .filter((e) => e.type === "tree" || e.type === "blob")
    .map((e) => ({ path: e.path, type: e.type as "tree" | "blob" }));

  return { sha: commit.sha, entries };
}

export interface WorkflowRun {
  id: number;
  name: string;
  event: string;
  status: string;
  conclusion: string | null;
  headBranch: string | null;
  htmlUrl: string;
  createdAt: string;
}

/** Recent Actions runs, newest first. Requires the `actions: read` permission. */
export async function listWorkflowRuns(
  token: string,
  params: { repoFullName: string; perPage?: number },
): Promise<WorkflowRun[]> {
  const res = await githubFetch(
    token,
    `/repos/${params.repoFullName}/actions/runs?per_page=${params.perPage ?? 10}`,
  );

  const body = (await res.json()) as {
    workflow_runs?: Array<{
      id: number;
      name: string | null;
      event: string;
      status: string | null;
      conclusion: string | null;
      head_branch: string | null;
      html_url: string;
      created_at: string;
    }>;
  };

  return (body.workflow_runs ?? []).map((run) => ({
    id: run.id,
    name: run.name ?? "Workflow",
    event: run.event,
    status: run.status ?? "unknown",
    conclusion: run.conclusion,
    headBranch: run.head_branch,
    htmlUrl: run.html_url,
    createdAt: run.created_at,
  }));
}

/** Path segments are encoded individually so the slashes survive. */
function encodeRepoPath(path: string): string {
  return path.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
}

/**
 * Starts a `workflow_dispatch` run.
 *
 * Needs the `actions: write` permission, and the workflow file must already
 * exist on the repository's default branch — GitHub reads the triggers from
 * there, so a workflow that was only just committed to another branch is not
 * dispatchable yet.
 */
export async function dispatchWorkflow(
  token: string,
  params: { repoFullName: string; workflowFile: string; ref: string },
): Promise<void> {
  const file = params.workflowFile.split("/").pop() ?? params.workflowFile;

  await githubFetch(
    token,
    `/repos/${params.repoFullName}/actions/workflows/${encodeURIComponent(
      file,
    )}/dispatches`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: params.ref }),
    },
  );
}
