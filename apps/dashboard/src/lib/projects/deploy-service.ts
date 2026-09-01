import "server-only";

import type { Project } from "@terrablox/database";

import { getRepoVariable } from "@/lib/github/actions-config";
import {
  commitFiles,
  type FileChange,
  GithubRequestError,
  listRepoTree,
  listWorkflowRuns,
  readRepoFile,
} from "@/lib/github/repo-files";

import {
  AWS_REGION_VARIABLE,
  AWS_ROLE_VARIABLE,
  BACKEND_FILE,
  bootstrapStackName,
  missingDeploySettings,
  type PipelineContext,
  renderBackendFile,
  renderBootstrapCommand,
  renderBootstrapTemplate,
  renderStateCommand,
  renderStateTemplate,
  renderTrustPolicy,
  STATE_BUCKET_VARIABLE,
  stateStackName,
  WORKFLOW_DIR,
} from "./deploy";
import { normalizeFolder } from "./service";
import type {
  DeployVariablesDto,
  ProjectDeployState,
  WorkflowFileDto,
} from "./types";
import {
  activeTemplates,
  allTemplatePaths,
  type ResolvedTemplateConfig,
  resolveTemplateConfig,
  WORKFLOW_TEMPLATES,
} from "./workflow-templates";

/** Exported so the account-side stacks are rendered from the same settings. */
export function pipelineContext(project: Project): PipelineContext {
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
    stateKmsKeyArn: project.stateKmsKeyArn,
    stateKmsAlias: project.stateKmsAlias,
  };
}

/**
 * Which CloudFormation stacks this project's bootstrap lives in.
 *
 * The stored name wins, and the old derivation is the fallback — so a project set
 * up before the names were pinned keeps looking at the stack it always did, and one
 * that has never been set up gets the name its first apply will pin.
 *
 * Both of these exist so that no caller derives a stack name itself. That is what
 * went wrong before: `DescribeStacks(bootstrapStackName(project.name))` silently
 * became a different stack the moment somebody renamed the project.
 */
export function roleStackNameOf(project: Project): string {
  return project.roleStackName ?? bootstrapStackName(project.name);
}

export function stateStackNameOf(project: Project): string {
  return project.stateStackName ?? stateStackName(project.name);
}

/** The template configuration this project deploys with. */
export function templateConfig(project: Project): ResolvedTemplateConfig {
  return resolveTemplateConfig(project.deployTemplates);
}

/** Where the backend file goes: next to the root configuration, not at the top. */
function backendPath(project: Project): string {
  const folder = normalizeFolder(project.terraformRootFolder);
  return folder === "." ? BACKEND_FILE : `${folder}/${BACKEND_FILE}`;
}

/**
 * The files TerraBlox writes for this project.
 *
 * Driven by the catalogue and the project's configuration, so a template the
 * project turned off is not merely hidden — it is never rendered, and
 * {@link writeDeployPipeline} deletes the file if it is already there.
 */
export function pipelineFiles(
  project: Project,
): { path: string; content: string }[] {
  const context = pipelineContext(project);
  const config = templateConfig(project);

  const files = activeTemplates(config).map((template) => ({
    path: template.path,
    content: template.render(context, config),
  }));

  const backend = renderBackendFile(context);
  if (backend) files.push({ path: backendPath(project), content: backend });

  return files;
}

/** The three variables together, or the reason none of them could be read. */
async function readRepoVariables(
  token: string,
  repoFullName: string,
): Promise<DeployVariablesDto> {
  try {
    const [role, region, stateBucket] = await Promise.all([
      getRepoVariable(token, { repoFullName, name: AWS_ROLE_VARIABLE }),
      getRepoVariable(token, { repoFullName, name: AWS_REGION_VARIABLE }),
      getRepoVariable(token, { repoFullName, name: STATE_BUCKET_VARIABLE }),
    ]);

    return { role, region, stateBucket, error: null };
  } catch (error) {
    return {
      role: null,
      region: null,
      stateBucket: null,
      error:
        error instanceof GithubRequestError
          ? "Repository variables are not readable with the current GitHub permissions."
          : "Could not read the repository variables.",
    };
  }
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
  const config = templateConfig(project);
  const managedPaths = new Set(expected.map((file) => file.path));

  // Includes the templates this project turned off: a file left behind from
  // before still runs in Actions, so it has to be visible and removable.
  const ownedPaths = new Set([...allTemplatePaths(), ...managedPaths]);

  const [tree, runs, existing, variables] = await Promise.all([
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
    // What the workflows will actually read at run time. Asking GitHub rather
    // than assuming the last write succeeded: the permission needed to set a
    // variable is one the installation may not have, and a pipeline pointed at
    // a stale role is exactly the failure that is hardest to read from a log.
    readRepoVariables(token, project.repoFullName),
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
        // A file TerraBlox owns but this project no longer wants counts as out
        // of date, which is what makes the "needs update" badge honest.
        upToDate: managed
          ? current?.content.trim() === rendered?.content.trim()
          : !ownedPaths.has(entry.path),
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

  const settings = {
    awsAccountId: project.awsAccountId,
    awsRegion: project.awsRegion,
    awsRoleArn: project.awsRoleArn,
    stateBucket: project.stateBucket,
    stateLockTable: project.stateLockTable,
    stateKmsKeyArn: project.stateKmsKeyArn,
  };

  const missing = missingDeploySettings(settings);

  // Committed *and* current: a workflow left behind by an older set of settings
  // would point at the wrong role, which is worse than having none.
  const pipelineReady =
    expected.length > 0 &&
    expected.every((file) => {
      const current = currentByPath.get(file.path);
      return current != null && current.content.trim() === file.content.trim();
    });

  // Compared against the project rather than merely present, so a role that was
  // replaced after the first setup shows as unfinished instead of done.
  const variablesReady =
    variables.error === null &&
    variables.role !== null &&
    variables.role === project.awsRoleArn &&
    variables.region === project.awsRegion &&
    variables.stateBucket === project.stateBucket;

  return {
    settings,
    missing,
    variables,
    templates: {
      config,
      catalogue: WORKFLOW_TEMPLATES.map((template) => ({
        id: template.id,
        path: template.path,
        name: template.name,
        summary: template.summary,
        required: template.required,
        requires: template.requires,
        enabled: template.required || !config.disabled.includes(template.id),
      })),
    },
    setup: {
      roleReady: project.awsRoleArn !== null,
      variablesReady,
      stateReady:
        project.stateBucket !== null && project.stateKmsKeyArn !== null,
      pipelineReady,
      complete: missing.length === 0 && variablesReady && pipelineReady,
    },
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
      stackName: roleStackNameOf(project),
      template: renderBootstrapTemplate(context),
      command: renderBootstrapCommand(context),
      consoleUrl: consoleUrl(project.awsRegion),
    },
    state: {
      stackName: stateStackNameOf(project),
      // Rendering needs a bucket name, which only exists once the wizard has
      // derived one; before that there is nothing to show.
      template: project.stateBucket ? renderStateTemplate(context) : null,
      command: renderStateCommand(context),
      consoleUrl: consoleUrl(project.awsRegion),
    },
  };
}

function consoleUrl(region: string): string {
  const encoded = encodeURIComponent(region);
  return `https://${encoded}.console.aws.amazon.com/cloudformation/home?region=${encoded}#/stacks/create`;
}

/**
 * Writes the pipeline in a single commit.
 *
 * One commit rather than one per file, so a repository is never left with a
 * plan workflow that refers to a backend that was not written. Templates the
 * project has turned off are deleted in the same commit: leaving them behind
 * would leave a runnable workflow nobody is looking after.
 */
export async function writeDeployPipeline(
  token: string,
  project: Project,
): Promise<{ sha: string; paths: string[] } | null> {
  const files = pipelineFiles(project);
  const wanted = new Set(files.map((file) => file.path));

  const changes: FileChange[] = files.map((file) => ({
    path: file.path,
    content: file.content,
  }));

  const disabledPaths = allTemplatePaths().filter((path) => !wanted.has(path));

  // Only delete what is actually there, or the tree update fails on a path that
  // never existed.
  const present = await Promise.all(
    disabledPaths.map((path) =>
      readRepoFile(token, {
        repoFullName: project.repoFullName,
        path,
        ref: project.repoBranch,
      })
        .then((file) => (file ? path : null))
        .catch(() => null),
    ),
  );

  for (const path of present) {
    if (path) changes.push({ path, content: null });
  }

  const result = await commitFiles(token, {
    repoFullName: project.repoFullName,
    branch: project.repoBranch,
    message: "chore(terrablox): update deployment pipeline",
    changes,
  });

  return result ? { sha: result.sha, paths: result.paths } : null;
}
