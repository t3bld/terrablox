import "server-only";

import type { Prisma } from "@terrablox/database";

import type {
  MigrationSourceCapture,
  RecordedDecision,
} from "@/lib/agent/project-agent";
import { database } from "@/lib/database";

import type { AgentStep, ProjectGraph, ProjectGraphMutation } from "./types";

/** How a turn's starting state was constituted, for filtering training examples. */
export type MigrationKind = "greenfield" | "graph" | "legacy";

/**
 * Recording a whole agent turn as training data for the harness.
 *
 * The transcript, the decision log and the operation log each keep a slice of a
 * turn, shaped for the screen that reads it. None keeps the graph the turn started
 * from, so the before/after pair — the transformation the harness is meant to learn
 * from — is gone the moment the turn returns. This module is the one place that
 * captures it, and it is deliberately kept out of the chat route: the route runs a
 * turn, this writes it down, and a fault in the writing must never reach the turn.
 *
 * Nothing here touches Git or GitHub.
 */

/** The outcome of a turn, as far as a recorded transformation is concerned. */
export type TransformationOutcome = "completed" | "stopped" | "error";

/**
 * The conditions a turn ran under.
 *
 * The same prompt under a different model or a tighter budget is a different
 * training example, so these travel with the before/after pair rather than being
 * inferred from it later.
 */
export interface TransformationSettings {
  model: string;
  reasoningEffort: string | null;
  maxToolCalls: number | null;
  maxSteps: number | null;
  allowDestructive: boolean | null;
  disabledTools: string[];
  disabledKnowledge: string[];
  /** Whether the agent was allowed to see the repository / library this turn. */
  seesRepo: boolean;
  seesLibrary: boolean;
}

/**
 * The linked application repository, pinned to the revision the turn read.
 *
 * Carried into the record so a captured read names the exact commit its content
 * came from. Null when the project links no app repo, which is the common case.
 */
export interface TransformationAppRepo {
  fullName: string;
  branch: string;
  sha: string | null;
}

/** Everything one transformation is made of, gathered in the chat route. */
export interface TransformationInput {
  projectId: string;
  userId: string;
  chatMessageId: string | null;
  prompt: string;
  reply: string;
  settings: TransformationSettings;
  graphBefore: ProjectGraph;
  graphAfter: ProjectGraph;
  /** The complete, untrimmed trail — the UI's capped copy lives on the message. */
  steps: AgentStep[];
  mutations: ProjectGraphMutation[];
  decisions: RecordedDecision[];
  commits: string[];
  mutationErrors: string[];
  outcome: TransformationOutcome;
  /** What the turn read beyond the graph, collected inside the tools. */
  migrationSource: MigrationSourceCapture;
  /** The app repo the reads were pinned to, when one was linked. */
  appRepo: TransformationAppRepo | null;
}

/**
 * Which of the three starting states this turn transformed from.
 *
 * `legacy` the moment the agent read anything external — an app-repo file or an MCP
 * call — because that read is the source it migrated from. Otherwise `greenfield`
 * when the before-graph was empty and `graph` when it was not. The distinction is
 * what a greenfield-versus-migration filter on the training set reads, so it is
 * computed once here rather than re-derived by every consumer.
 */
function classifyMigration(
  graphBefore: ProjectGraph,
  source: MigrationSourceCapture,
): MigrationKind {
  if (source.appRepoReads.length > 0 || source.mcpCalls.length > 0) {
    return "legacy";
  }
  return graphBefore.nodes.length > 0 ? "graph" : "greenfield";
}

/** JSON round-trip, because Prisma's input type wants an index signature our DTOs do not have. */
function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Writes one transformation, or does nothing when there is nothing to learn from.
 *
 * A turn that committed nothing left the graph exactly as it found it, and a
 * before/after pair with no difference is not an example of a transformation. Such
 * turns are skipped here rather than at the call site, so the caller only has to
 * ask once.
 *
 * Never throws. The caller invokes this fire-and-forget: a failed write is one lost
 * training row, and losing the turn it describes would be the worse trade. Any error
 * is logged and swallowed.
 */
export async function recordTransformation(
  input: TransformationInput,
): Promise<void> {
  if (input.commits.length === 0 && input.mutations.length === 0) return;

  try {
    await database.projectTransformation.create({
      data: {
        projectId: input.projectId,
        userId: input.userId,
        chatMessageId: input.chatMessageId,
        prompt: input.prompt,
        reply: input.reply,
        settings: json(input.settings),
        graphBefore: json(input.graphBefore),
        graphAfter: json(input.graphAfter),
        steps: json(input.steps),
        mutations: json(input.mutations),
        decisions: json(input.decisions),
        migrationSource: json({
          kind: classifyMigration(input.graphBefore, input.migrationSource),
          appRepo: input.appRepo,
          appRepoReads: input.migrationSource.appRepoReads,
          mcpCalls: input.migrationSource.mcpCalls,
        }),
        commits: input.commits,
        mutationErrors: input.mutationErrors,
        outcome: input.outcome,
      },
    });
  } catch (error) {
    console.warn("[transformation] could not record turn", {
      project: input.projectId,
      reason: error instanceof Error ? error.message : "unknown",
    });
  }
}

/**
 * Fills in the pipeline's verdict on a project's most recent transformation.
 *
 * The outcome signal — did the turn produce valid Terraform — is the label that
 * makes a transformation worth training on, and it is not known when the turn
 * finishes: the pipeline has not run yet. The next turn reads that run anyway
 * (`readLastCheck`), so this backfills from it, matching the run to the newest
 * transformation that is still waiting for one.
 *
 * Only a finished run carries a verdict: a run still queued or in progress has a
 * null conclusion and is left for a later turn to resolve. Never throws, for the
 * same reason `recordTransformation` does not — this is bookkeeping on the previous
 * turn, and the current one must not fail for it.
 */
export async function backfillPipelineOutcome(
  projectId: string,
  check: { status: string | null; conclusion: string | null } | null,
): Promise<void> {
  if (!check || check.status !== "completed" || !check.conclusion) return;

  try {
    const latest = await database.projectTransformation.findFirst({
      where: { projectId, pipelineConclusion: null },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (!latest) return;

    await database.projectTransformation.update({
      where: { id: latest.id },
      data: {
        pipelineConclusion: check.conclusion,
        pipelineCheckedAt: new Date(),
      },
    });
  } catch (error) {
    console.warn("[transformation] could not backfill pipeline outcome", {
      project: projectId,
      reason: error instanceof Error ? error.message : "unknown",
    });
  }
}
