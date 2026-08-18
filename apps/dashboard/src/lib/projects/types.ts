/**
 * Shapes exchanged between the project API and the project UI.
 *
 * Free of `server-only` imports so the canvas and the chat panel can type their
 * props against the same definitions the route handlers produce.
 */

export interface ProjectDto {
  id: string;
  name: string;
  description: string | null;
  provider: string;
  repoFullName: string;
  repoUrl: string | null;
  repoBranch: string;
  terraformRootFolder: string;
  terraformEntryFile: string;
  lastSyncedSha: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectGraphPort {
  name: string;
  description: string | null;
  /** Inputs only: a required input without a value blocks `terraform plan`. */
  required?: boolean;
  type?: string | null;
}

export interface ProjectGraphNode {
  /** The `module` block label, which is also the node's identity in the repo. */
  id: string;
  label: string;
  /** Raw `source` argument as written in the file. */
  source: string | null;
  version: string | null;
  sourceKind: string;
  /** File the block lives in, relative to the repository root. */
  file: string | null;
  /** Imported module this call resolves to, when the library knows it. */
  moduleId: string | null;
  moduleName: string | null;
  /** Whether the imported module matches the pinned ref rather than a fallback. */
  exactVersion: boolean;
  inputs: ProjectGraphPort[];
  outputs: ProjectGraphPort[];
  /** Arguments the block sets, so the canvas can show what is already wired. */
  setArguments: string[];
  /** Those arguments' expressions as written, for the inspector to edit. */
  values: Record<string, string>;
  position: { x: number; y: number } | null;
}

/**
 * A required input nobody has filled in, and what could fill it.
 *
 * Computed server-side because it needs the whole module library, which the UI
 * only ever sees a summary of.
 */
export interface ProjectGraphGap {
  /** Block label of the module missing the value. */
  node: string;
  input: string;
  type: string | null;
  /** Modules already on the canvas that expose a matching output. */
  wirable: { node: string; output: string }[];
  /** Library modules that would expose one once added. */
  candidates: { moduleId: string; name: string; output: string }[];
}

/** One wire: an argument of the target fed by an output of the source. */
export interface ProjectGraphLink {
  /** Argument of the target that carries the reference, e.g. `vpc_id`. */
  targetInput: string;
  /** Output it reads, when the expression names one plainly. */
  sourceOutput: string | null;
}

export interface ProjectGraphEdge {
  id: string;
  /** Module whose output is consumed. */
  source: string;
  /** Module that consumes it. */
  target: string;
  /** Every argument connecting these two modules. */
  links: ProjectGraphLink[];
}

export interface ProjectGraph {
  nodes: ProjectGraphNode[];
  edges: ProjectGraphEdge[];
  /** Required inputs still without a value, newest module first. */
  gaps: ProjectGraphGap[];
  /** Root-level `resource`/`data` blocks, summarised rather than drawn. */
  resourceCount: number;
  files: string[];
  /** Commit the graph was built from. */
  sha: string;
  errors: Array<{ file: string; message: string }>;
}

export interface ProjectChatMessageDto {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/**
 * One step of an agent turn, kept so the user can see how a change came about.
 *
 * `thought` is the model's own summary of its reasoning; `tool` is an edit it
 * asked for, including the ones we rejected — a refused call explains a
 * surprising answer better than its absence does.
 */
export type AgentStep =
  | { kind: "thought"; text: string }
  | { kind: "tool"; tool: string; summary: string; ok: boolean };

export type ProjectGraphMutation =
  | {
      action: "add-module";
      /** Imported module to instantiate, from the module library. */
      moduleId: string;
      /** Preferred block label; a suffix is added on collision. */
      name?: string;
      position?: { x: number; y: number };
    }
  | { action: "remove-module"; name: string }
  | {
      action: "connect";
      source: string;
      sourceOutput: string;
      target: string;
      targetInput: string;
    }
  | { action: "disconnect"; target: string; targetInput: string }
  | { action: "rename-module"; name: string; newName: string }
  /** Sets an argument to a literal or an expression the user typed. */
  | { action: "set-argument"; name: string; input: string; value: string }
  /** Fills a module's required inputs from unambiguous matches on the canvas. */
  | { action: "auto-connect"; name: string };

export interface ProjectMutationResult {
  graph: ProjectGraph;
  commit: { sha: string; path: string; message: string } | null;
}

/** Who made an edit. The canvas and the agent share one code path, not one hand. */
export type OperationOrigin = "canvas" | "agent";

export interface ProjectOperationDto {
  id: string;
  origin: OperationOrigin;
  action: string;
  summary: string;
  commitSha: string | null;
  /** Branch head the edit was applied on top of, i.e. the state to go back to. */
  parentSha: string | null;
  createdAt: string;
}

export interface ProjectDeploySettings {
  awsAccountId: string | null;
  awsRegion: string;
  awsRoleArn: string | null;
  stateBucket: string | null;
  stateLockTable: string | null;
}

export interface WorkflowFileDto {
  path: string;
  /** Whether TerraBlox generated this file and still owns its content. */
  managed: boolean;
  /** Managed files only: false when the repository copy has drifted. */
  upToDate: boolean;
}

export interface WorkflowRunDto {
  id: number;
  name: string;
  event: string;
  status: string;
  conclusion: string | null;
  headBranch: string | null;
  htmlUrl: string;
  createdAt: string;
}

export interface ProjectDeployState {
  settings: ProjectDeploySettings;
  /** What still has to be filled in before the pipeline can run. */
  missing: string[];
  workflows: WorkflowFileDto[];
  hasBackendFile: boolean;
  backendUpToDate: boolean;
  runs: WorkflowRunDto[];
  /** Why the run list is empty, when reading it was not permitted. */
  runsError: string | null;
  /** Files the pipeline would be written as, for review before committing. */
  preview: { path: string; content: string }[];
  trustPolicy: string;
  /** The account-side prerequisites, for the user to run with their own credentials. */
  bootstrap: {
    stackName: string;
    template: string;
    command: string;
    consoleUrl: string;
  };
}

/** The workflows TerraBlox can start on the user's behalf. */
export type DeployRunKind = "plan" | "apply" | "state" | "cost";
