import "server-only";

import type { Tool } from "@github/copilot-sdk";
import {
  KNOWLEDGE_MODULE_LIBRARY,
  KNOWLEDGE_PROJECT_DOCUMENTS,
  KNOWLEDGE_PROJECT_REPO,
  knowledgeEnabled,
} from "@terrablox/agent-harness/knowledge";
import {
  AGENT_MAX_TOOL_CALLS,
  renderOperatingRule,
} from "@terrablox/agent-harness/runtime-options";
import { PROJECT_AGENT_TOOLS } from "@terrablox/agent-harness/tool-catalogue";
import type { Project } from "@terrablox/database";
import { listWorkflowRuns } from "@terrablox/git/actions";
import { getBranchHead } from "@terrablox/git/files";
import { getRepository } from "@terrablox/git/repositories";
import {
  COPILOT_REASONING_EFFORT,
  resolveCopilotModel,
} from "@/lib/agent/copilot";
import { getEffectiveAgentSettings } from "@/lib/agent/effective-settings";
import { getHarnessCuration } from "@/lib/agent/harness-curation";
import { toAgentLibrary } from "@/lib/agent/library-view";
import {
  mcpServersForSession,
  type ReasoningEffortValue,
} from "@/lib/agent/settings-service";
import type {
  AgentAppRepo,
  AgentContext,
  AgentPipelineCheck,
} from "@/lib/agent/turn-context";
import { database } from "@/lib/database";
import { readContextDocumentSlice } from "@/lib/projects/context-documents";
import { activeDecisions } from "@/lib/projects/decisions";
import {
  loadProjectGraph,
  readModuleLibrary,
  readModuleResourceTypes,
} from "@/lib/projects/service";
import type { AgentStep, ProjectGraph } from "@/lib/projects/types";

/**
 * The tools that change the project. Withheld while the run is planning, so the
 * plan is reviewed before anything is built.
 */
const EDITING_TOOLS = PROJECT_AGENT_TOOLS.filter(
  (tool) => tool.group === "modules" || tool.group === "locals",
).map((tool) => tool.name);

/** The project with the run's branch in place of its own. Never persisted. */
export function onBranch(project: Project, branch: string): Project {
  return { ...project, repoBranch: branch };
}

/**
 * Everything one iteration of a run is handed.
 *
 * The same sources and settings a chat turn gets, so Agent mode obeys the user's
 * agent settings (knowledge switches, disabled tools, budgets, MCP servers) the
 * same way. The one difference: there is no chat history, because the run
 * carries its own memory in the task brief.
 */
export async function buildRunContext(params: {
  project: Project;
  userId: string;
  branch: string;
  token: string;
  planning: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: the SDK types its own tool list as `Tool<any>[]`.
  extraTools: Tool<any>[];
  onStep: (steps: AgentStep[]) => void;
  signal: AbortSignal;
}): Promise<{ context: AgentContext; model: string }> {
  const { project, userId, branch, token } = params;
  const branchProject = onBranch(project, branch);

  const [
    graph,
    library,
    settings,
    mcpServers,
    curation,
    application,
    contextDocuments,
    decisions,
  ] = await Promise.all([
    loadProjectGraph(token, branchProject),
    readModuleLibrary(userId),
    getEffectiveAgentSettings(userId, project.id),
    mcpServersForSession(userId),
    getHarnessCuration(userId),
    resolveAppRepo(token, project),
    database.projectContextDocument.findMany({
      where: { projectId: project.id, userId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        originalName: true,
        mediaType: true,
        characterCount: true,
      },
    }),
    activeDecisions(project.id),
  ]);

  const seesRepo = knowledgeEnabled(
    settings.disabledKnowledge,
    KNOWLEDGE_PROJECT_REPO,
  );
  const seesLibrary = knowledgeEnabled(
    settings.disabledKnowledge,
    KNOWLEDGE_MODULE_LIBRARY,
  );
  const seesDocuments = knowledgeEnabled(
    settings.disabledKnowledge,
    KNOWLEDGE_PROJECT_DOCUMENTS,
  );

  const modelChoice = await resolveCopilotModel(token, settings.model);
  const lastCheck = seesRepo
    ? await readBranchCheck(token, project.repoFullName, branch)
    : null;

  const context: AgentContext = {
    projectName: project.name,
    repoFullName: project.repoFullName,
    branch,
    appRepo: application.appRepo,
    appRepoLink: project.appRepoFullName
      ? { fullName: project.appRepoFullName }
      : null,
    appRepoProblem: application.problem,
    contextDocuments: seesDocuments
      ? contextDocuments.map((document) => ({
          id: document.id,
          name: document.originalName,
          mediaType: document.mediaType,
          characterCount: document.characterCount,
        }))
      : [],
    readContextDocument: seesDocuments
      ? (documentId, offset) =>
          readContextDocumentSlice(project.id, documentId, offset)
      : undefined,
    graph: seesRepo ? graph : blindGraph(graph.sha),
    userId,
    projectId: project.id,
    githubToken: token,
    instructions: settings.instructions,
    disabledKnowledge: settings.disabledKnowledge,
    mcpServers,
    model: modelChoice.model,
    reasoningEffort: COPILOT_REASONING_EFFORT as ReasoningEffortValue,
    disabledTools: [
      ...(settings.disabledTools ?? []),
      ...(params.planning ? EDITING_TOOLS : []),
    ],
    turnTimeout: settings.turnTimeout,
    maxToolCalls: settings.maxToolCalls,
    maxMcpCalls: settings.maxMcpCalls,
    historyBudgetChars: settings.historyBudgetChars,
    maxSteps: settings.maxSteps,
    maxAppRepoReads: settings.maxAppRepoReads,
    appRepoTreeLimit: settings.appRepoTreeLimit,
    appRepoFileChars: settings.appRepoFileChars,
    allowDestructive: settings.allowDestructive,
    operatingRules: curation.operatingRulesRaw.map((rule) =>
      renderOperatingRule(rule, settings.maxToolCalls ?? AGENT_MAX_TOOL_CALLS),
    ),
    toolDescriptions: Object.fromEntries(
      curation.operations.map((operation) => [
        operation.name,
        operation.description,
      ]),
    ),
    library: seesLibrary ? toAgentLibrary(library) : [],
    moduleResources: (moduleIds) => readModuleResourceTypes(userId, moduleIds),
    lastCheck,
    history: [],
    // Withheld with the repository, as in the chat: a decision is a statement
    // about the Terraform.
    decisions: seesRepo
      ? decisions.map((decision) => ({
          id: decision.id,
          question: decision.question,
          choice: decision.choice,
          reason: decision.reason,
          rejected: decision.alternatives.map(
            (entry) => `${entry.option} (${entry.reason})`,
          ),
        }))
      : [],
    onStep: params.onStep,
    signal: params.signal,
    extraTools: params.extraTools,
  };

  return { context, model: modelChoice.model };
}

/** Same as the chat route's: an empty graph that still validates. */
function blindGraph(sha: string): ProjectGraph {
  return {
    nodes: [],
    edges: [],
    gaps: [],
    resourceCount: 0,
    files: [],
    sha,
    errors: [],
  };
}

/** The newest pipeline run on the run's branch, or null. Never fatal. */
export async function readBranchCheck(
  token: string,
  repoFullName: string,
  branch: string,
): Promise<AgentPipelineCheck | null> {
  try {
    const runs = await listWorkflowRuns(token, { repoFullName, perPage: 20 });
    const run = runs.find((entry) => entry.headBranch === branch);
    if (!run) return null;
    return {
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      htmlUrl: run.htmlUrl,
      createdAt: run.createdAt,
    };
  } catch {
    return null;
  }
}

/** The linked application repository, resolved as the chat route does it. */
async function resolveAppRepo(
  token: string,
  project: { appRepoFullName: string | null; appRepoBranch: string | null },
): Promise<{ appRepo: AgentAppRepo | null; problem: string | null }> {
  if (!project.appRepoFullName) return { appRepo: null, problem: null };

  try {
    const repository = await getRepository(token, project.appRepoFullName);
    const branch = project.appRepoBranch ?? repository.defaultBranch;
    const sha = await getBranchHead(token, {
      repoFullName: repository.fullName,
      branch,
    }).catch(() => null);

    return {
      appRepo: { fullName: repository.fullName, branch, sha, token },
      problem: null,
    };
  } catch {
    return {
      appRepo: null,
      problem:
        "The linked application repository could not be read, so its contents are not available in this run.",
    };
  }
}
