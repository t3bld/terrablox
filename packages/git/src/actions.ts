/**
 * GitHub Actions: the runs, starting one, and the variables a workflow reads.
 *
 * The repository variables live here rather than with the repository itself, because
 * that is what they are for. Terrablox writes the role ARN, the region and the state
 * bucket into them so the generated workflows can find them without the values being
 * committed — which means they belong to the pipeline, not to the repository.
 */

import { GithubRequestError, githubRequest } from "./client";

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
  const res = await githubRequest(
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

  await githubRequest(
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
    const res = await githubRequest(
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
    await githubRequest(
      token,
      `/repos/${params.repoFullName}/actions/variables`,
      { method: "POST", body, headers },
    );
  } catch (error) {
    const exists =
      error instanceof GithubRequestError &&
      (error.status === 409 || error.status === 422);
    if (!exists) throw error;

    await githubRequest(
      token,
      `/repos/${params.repoFullName}/actions/variables/${params.name}`,
      { method: "PATCH", body, headers },
    );
  }
}
