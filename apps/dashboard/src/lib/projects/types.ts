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
  /**
   * The application this infrastructure is for, as `owner/name`.
   *
   * Read-only: TerraBlox never commits here. Null means the project was never
   * linked to one, which is a working project — the agent asks about the
   * application instead of reading it.
   */
  appRepoFullName: string | null;
  /** Ref the application is read at. Null falls back to its default branch. */
  appRepoBranch: string | null;
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

/**
 * What a node on the canvas stands for.
 *
 * `module` is a block that creates infrastructure; `local` is a named value that
 * feeds one. They share the node type because they share the canvas, the
 * position store and the wiring, but almost nothing else — a local has no source,
 * no version and no ports of its own.
 */
export type ProjectNodeKind = "module" | "local";

export interface ProjectGraphNode {
  /** The block label (module) or the local's name, which is its identity. */
  id: string;
  label: string;
  kind: ProjectNodeKind;
  /**
   * Locals only: the expression as written. A module carries its arguments in
   * `values` instead, because it has many and a local has exactly one.
   */
  expression: string | null;
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
  /**
   * The element it reads, when the output is a list and the expression subscripts
   * it plainly: `module.vpc.public_subnets[0]` is 0.
   *
   * Null for an unsubscripted or computed reference. The canvas ignores it — one
   * wire is one wire however it is indexed — but the architecture level draws one
   * frame per availability zone, and this is what says which of them a box is in
   * rather than leaving it to a convention.
   */
  sourceIndex: number | null;
}

export interface ProjectGraphEdge {
  id: string;
  /** Node whose value is consumed: a module's output, or a local. */
  source: string;
  /** Node that consumes it. */
  target: string;
  /**
   * What the source is. A local has no named output, so `sourceOutput` is always
   * null on its links and the canvas must not offer a port picker for them.
   */
  sourceKind: ProjectNodeKind;
  targetKind: ProjectNodeKind;
  /** Every argument connecting these two nodes. */
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
  /**
   * Several arguments of one module, in one edit.
   *
   * The canvas never needs this — its inspector edits one field at a time — but
   * the agent does. Configuring a database is a dozen values, and as a dozen
   * mutations that was a dozen commits and a dozen units of a budget whose whole
   * purpose is to bound how much one unreviewed turn changes. It is one change to
   * one block, so it counts as one.
   */
  | {
      action: "set-arguments";
      name: string;
      values: Array<{ input: string; value: string }>;
    }
  /** Fills a module's required inputs from unambiguous matches on the canvas. */
  | { action: "auto-connect"; name: string }
  /**
   * Declares a named value in a `locals` block.
   *
   * `connectTo` exists because creating a local and wiring it are one gesture on
   * the canvas — dragging from an unfilled input. Two mutations would put two
   * commits and two history entries behind a single user action.
   */
  | {
      action: "add-local";
      name: string;
      value: string;
      position?: { x: number; y: number };
      connectTo?: { target: string; targetInput: string };
    }
  | { action: "set-local"; name: string; value: string }
  | { action: "rename-local"; name: string; newName: string }
  | { action: "remove-local"; name: string }
  /** Points a module's input at a local. */
  | {
      action: "connect-local";
      local: string;
      target: string;
      targetInput: string;
    };

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

/** One rejected option and the reason it lost. */
export interface DecisionAlternativeDto {
  option: string;
  reason: string;
}

/**
 * The intent a decision declared, before anything was built.
 *
 * Kept beside the operations rather than merged into them: a plan naming ten
 * modules next to a turn that added ten and wired none is the story of that turn,
 * and merging the two would erase it.
 */
export interface DecisionPlanDto {
  modules: Array<{ moduleId: string; name?: string; purpose?: string }>;
  wiring: Array<{
    target: string;
    targetInput: string;
    source?: string;
    sourceOutput?: string;
  }>;
}

/**
 * Why the infrastructure looks the way it does — an architecture decision record,
 * shaped after one and named plainly.
 *
 * `context` is what the requirements were understood to be, and it is a claim
 * rather than a fact. `origin` says whose claim.
 */
export interface ProjectDecisionDto {
  id: string;
  origin: "agent" | "user";
  question: string;
  context: string;
  choice: string;
  reason: string;
  alternatives: DecisionAlternativeDto[];
  plan: DecisionPlanDto;
  status: "active" | "superseded";
  supersededById: string | null;
  createdAt: string;
}

/**
 * One turn's worth of work: what was asked, what the agent did, what it changed.
 *
 * The assistant message *is* the turn — it already carries the reply, the step
 * trail and the commit list — so the log groups operations by it rather than by a
 * table of its own.
 *
 * Built from messages rather than from operations, which matters for the turns that
 * changed nothing: "the library has no DocumentDB module, tell me what you want
 * instead" is a turn worth reading and it produced no commit at all.
 */
export interface ProjectLogTurnDto {
  /** Null for a canvas gesture, which is an operation with no turn behind it. */
  chatMessageId: string | null;
  prompt: string | null;
  reply: string | null;
  createdAt: string;
  /**
   * What the agent did on the way to its answer: reasoning summaries, tool calls,
   * refusals. The trajectory proper — operations are only the part that committed.
   */
  steps: AgentStep[];
  commits: string[];
  decisionId: string | null;
  operations: ProjectOperationDto[];
}

/**
 * The project's log, flat.
 *
 * Two lists rather than a nesting, because the two views slice it differently: a
 * trajectory reads across turns and ignores decisions, a decision record reads the
 * other way round. Nesting forced one of the two to be reconstructed.
 */
export interface ProjectLogDto {
  /** Newest turn first. */
  turns: ProjectLogTurnDto[];
  /** Newest decision first. */
  decisions: ProjectDecisionDto[];
}

export interface ProjectDeploySettings {
  awsAccountId: string | null;
  awsRegion: string;
  awsRoleArn: string | null;
  stateBucket: string | null;
  stateLockTable: string | null;
  /** The KMS key the state is encrypted with, from the state stack. */
  stateKmsKeyArn: string | null;
}

/** One workflow template as the wizard lists it. */
export interface WorkflowTemplateDto {
  id: string;
  path: string;
  name: string;
  summary: string;
  /** Required templates cannot be turned off. */
  required: boolean;
  /** What the template needs before it can work, e.g. a repository secret. */
  requires: string | null;
  enabled: boolean;
}

export interface DeployTemplatesDto {
  config: {
    disabled: string[];
    terraformVersion: string;
    requireApproval: boolean;
    scheduleRefresh: boolean;
  };
  catalogue: WorkflowTemplateDto[];
}

/** A CloudFormation stack the setup runs, and how to run it by hand instead. */
export interface DeployStackDto {
  stackName: string;
  /** Null when the stack cannot be rendered yet, e.g. before a name is derived. */
  template: string | null;
  command: string;
  consoleUrl: string;
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

/** What the workflows will read at run time, straight from GitHub. */
export interface DeployVariablesDto {
  role: string | null;
  region: string | null;
  stateBucket: string | null;
  /** Set when none of them could be read, e.g. a missing GitHub permission. */
  error: string | null;
}

/**
 * How far the deployment setup has got.
 *
 * Derived from the account, the repository and the project on every read rather
 * than stored as progress. A stored flag would keep claiming the setup was done
 * after somebody deleted the workflow or pointed the role somewhere else, and
 * the one thing this state has to be is true.
 */
export interface DeploySetupState {
  /** The deployment role exists and is known. */
  roleReady: boolean;
  /** The repository variables match what this project would deploy with. */
  variablesReady: boolean;
  /** The state bucket and its encryption key exist. */
  stateReady: boolean;
  /** The workflow files are committed and current. */
  pipelineReady: boolean;
  complete: boolean;
}

export interface ProjectDeployState {
  settings: ProjectDeploySettings;
  /** What still has to be filled in before the pipeline can run. */
  missing: string[];
  variables: DeployVariablesDto;
  setup: DeploySetupState;
  workflows: WorkflowFileDto[];
  /** Kept for the pipeline preview; the backend file is not a template. */
  hasBackendFile: boolean;
  backendUpToDate: boolean;
  runs: WorkflowRunDto[];
  /** Why the run list is empty, when reading it was not permitted. */
  runsError: string | null;
  /** Files the pipeline would be written as, for review before committing. */
  preview: { path: string; content: string }[];
  trustPolicy: string;
  templates: DeployTemplatesDto;
  /** The role and OIDC trust, for the user to run with their own credentials. */
  bootstrap: DeployStackDto;
  /** The encrypted state backend, kept as its own stack. */
  state: DeployStackDto;
}

/** The workflows TerraBlox can start on the user's behalf. */
export type DeployRunKind = "plan" | "apply" | "cost";
