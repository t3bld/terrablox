import "server-only";

import type { Project } from "@terrablox/database";

import {
  commitFiles,
  type FileChange,
  GithubRequestError,
  listRepoTree,
  listWorkflowRuns,
  readRepoFile,
} from "@/lib/github/repo-files";

import {
  APPLY_WORKFLOW_PATH,
  BACKEND_FILE,
  bootstrapStackName,
  COST_WORKFLOW_PATH,
  missingDeploySettings,
  type PipelineContext,
  PLAN_WORKFLOW_PATH,
  renderApplyWorkflow,
  renderBackendFile,
  renderBootstrapCommand,
  renderBootstrapTemplate,
  renderCostWorkflow,
  renderPlanWorkflow,
  renderStateWorkflow,
  renderTrustPolicy,
  STATE_WORKFLOW_PATH,
  WORKFLOW_DIR,
} from "./deploy";
import { normalizeFolder } from "./service";
import type { ProjectDeployState, WorkflowFileDto } from "./types";

function pipelineContext(project: Project): PipelineContext {
  return {
    repoFullName: project.repoFullName,
    branch: project.repoBranch,
    rootFolder: normalizeFolder(project.terraformRootFolder),
    projectName: project.name,
    awsAccountId: project.awsAccountId,
    awsRegion: project.awsRegion,
    awsRoleArn: project.awsRoleArn,
    stateBucket: project.stateBucket,
    stateLockTable: project.stateLockTable,
  };
}

/** Where the backend file goes: next to the root configuration, not at the top. */
function backendPath(project: Project): string {
  const folder = normalizeFolder(project.terraformRootFolder);
  return folder === "." ? BACKEND_FILE : `${folder}/${BACKEND_FILE}`;
}

/** The files TerraBlox generates, in the order the UI shows them. */
export function pipelineFiles(
  project: Project,
): { path: string; content: string }[] {
  const context = pipelineContext(project);
  const files = [
    { path: PLAN_WORKFLOW_PATH, content: renderPlanWorkflow(context) },
    { path: APPLY_WORKFLOW_PATH, content: renderApplyWorkflow(context) },
    { path: STATE_WORKFLOW_PATH, content: renderStateWorkflow(context) },
    { path: COST_WORKFLOW_PATH, content: renderCostWorkflow(context) },
  ];

  const backend = renderBackendFile(context);
  if (backend) files.push({ path: backendPath(project), content: backend });

  return files;
}

/**
 * Everything the deploy tab shows.
 *
 * Reads the repository rather than trusting the database: a workflow can be
 * edited or deleted in Git at any time, and a tab that claimed a pipeline
 * existed when it no longer did would be worse than no tab at all.
 */
export async function readDeployState(
  token: string,
  project: Project,
): Promise<ProjectDeployState> {
  const expected = pipelineFiles(project);
  const context = pipelineContext(project);
  const managedPaths = new Set(expected.map((file) => file.path));

  const [tree, runs, existing] = await Promise.all([
    listRepoTree(token, {
      repoFullName: project.repoFullName,
      ref: project.repoBranch,
    }).catch(() => ({ sha: "", entries: [] })),
    // Reading runs needs a permission the app may not have been granted; the
    // rest of the tab still works without it.
    listWorkflowRuns(token, { repoFullName: project.repoFullName })
      .then((value) => ({ value, error: null as string | null }))
      .catch((error: unknown) => ({
        value: [],
        error:
          error instanceof GithubRequestError
            ? "Workflow runs are not readable with the current GitHub permissions."
            : "Could not read workflow runs.",
      })),
    Promise.all(
      expected.map((file) =>
        readRepoFile(token, {
          repoFullName: project.repoFullName,
          path: file.path,
          ref: project.repoBranch,
        }).catch(() => null),
      ),
    ),
  ]);

  const currentByPath = new Map(
    expected.map((file, index) => [file.path, existing[index] ?? null]),
  );

  const workflows: WorkflowFileDto[] = tree.entries
    .filter(
      (entry) =>
        entry.type === "blob" &&
        entry.path.startsWith(`${WORKFLOW_DIR}/`) &&
        /\.ya?ml$/.test(entry.path),
    )
    .map((entry) => {
      const managed = managedPaths.has(entry.path);
      const rendered = expected.find((file) => file.path === entry.path);
      const current = currentByPath.get(entry.path);

      return {
        path: entry.path,
        managed,
        upToDate: managed
          ? current?.content.trim() === rendered?.content.trim()
          : true,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  // A managed workflow that is not in the tree yet still belongs in the list,
  // so the user can see what is missing instead of only what exists.
  for (const file of expected) {
    if (file.path === backendPath(project)) continue;
    if (workflows.some((workflow) => workflow.path === file.path)) continue;
    workflows.push({ path: file.path, managed: true, upToDate: false });
  }

  const backendFile = currentByPath.get(backendPath(project)) ?? null;
  const renderedBackend = expected.find(
    (file) => file.path === backendPath(project),
  );

  return {
    settings: {
      awsAccountId: project.awsAccountId,
      awsRegion: project.awsRegion,
      awsRoleArn: project.awsRoleArn,
      stateBucket: project.stateBucket,
      stateLockTable: project.stateLockTable,
    },
    missing: missingDeploySettings({
      awsAccountId: project.awsAccountId,
      awsRegion: project.awsRegion,
      awsRoleArn: project.awsRoleArn,
      stateBucket: project.stateBucket,
      stateLockTable: project.stateLockTable,
    }),
    workflows,
    hasBackendFile: backendFile !== null,
    backendUpToDate:
      backendFile?.content.trim() === renderedBackend?.content.trim(),
    runs: runs.value,
    runsError: runs.error,
    preview: expected,
    trustPolicy: renderTrustPolicy({
      awsAccountId: project.awsAccountId,
      repoFullName: project.repoFullName,
      branch: project.repoBranch,
    }),
    bootstrap: {
      stackName: bootstrapStackName(project.name),
      template: renderBootstrapTemplate(context),
      command: renderBootstrapCommand(context),
      consoleUrl: `https://${encodeURIComponent(
        project.awsRegion,
      )}.console.aws.amazon.com/cloudformation/home?region=${encodeURIComponent(
        project.awsRegion,
      )}#/stacks/create`,
    },
  };
}

/**
 * Writes the pipeline in a single commit.
 *
 * One commit rather than one per file, so a repository is never left with a
 * plan workflow that refers to a backend that was not written.
 */
export async function writeDeployPipeline(
  token: string,
  project: Project,
): Promise<{ sha: string; paths: string[] } | null> {
  const changes: FileChange[] = pipelineFiles(project).map((file) => ({
    path: file.path,
    content: file.content,
  }));

  const result = await commitFiles(token, {
    repoFullName: project.repoFullName,
    branch: project.repoBranch,
    message: "chore(terrablox): update deployment pipeline",
    changes,
  });

  return result ? { sha: result.sha, paths: result.paths } : null;
}
