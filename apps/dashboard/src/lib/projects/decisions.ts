import "server-only";

import { database } from "@/lib/database";

import type {
  AgentStep,
  DecisionAlternativeDto,
  DecisionPlanDto,
  ProjectDecisionDto,
  ProjectLogDto,
  ProjectLogTurnDto,
  ProjectOperationDto,
} from "./types";

/**
 * Reading and writing the project's decision log.
 *
 * The operation log answers "what changed, when" and cannot answer "why" — the
 * reason was never stored anywhere durable, only in an assistant reply and a step
 * trail that a busy turn overflowed. This is the missing half, and it is a separate
 * grain rather than a different grouping: one decision about where an application's
 * data lives produced twenty-nine operations across two turns.
 *
 * Kept out of `service.ts`, which is about applying mutations to a repository.
 * Nothing here touches Git.
 */

/**
 * How much of the log is served.
 *
 * Turns are the rows and operations are their contents, so the two need different
 * numbers: sixty turns is a long working history, and those sixty turns can easily
 * hold two thousand operations between them.
 */
const TURN_LIMIT = 60;
const OPERATION_LIMIT = 2000;

/**
 * A decision as the agent recorded it, before it has an id.
 *
 * `supersedes` names a decision already in force. Validated by the caller against
 * this project, because a chain pointing at somebody else's decision would be
 * worse than no chain.
 */
export interface DecisionInput {
  question: string;
  context: string;
  choice: string;
  reason: string;
  alternatives: DecisionAlternativeDto[];
  plan: DecisionPlanDto;
  supersedes?: string;
}

/**
 * Writes a decision and, when it replaces one, marks the older one superseded.
 *
 * Two writes rather than one, and deliberately not a transaction: the second is
 * bookkeeping on a row that is still perfectly readable without it. A decision
 * recorded without its predecessor being marked is a small untidiness; a decision
 * lost because the marking failed is the reason the log exists gone.
 */
export async function recordDecision(
  projectId: string,
  origin: "agent" | "user",
  input: DecisionInput,
): Promise<string> {
  const created = await database.projectDecision.create({
    data: {
      projectId,
      origin,
      question: input.question,
      context: input.context,
      choice: input.choice,
      reason: input.reason,
      // Round-tripped through JSON: Prisma's input type wants an index signature
      // these interfaces deliberately do not have.
      alternatives: JSON.parse(JSON.stringify(input.alternatives)),
      plan: JSON.parse(JSON.stringify(input.plan)),
    },
    select: { id: true },
  });

  if (input.supersedes) {
    await database.projectDecision
      .updateMany({
        // Scoped to the project: an id from the prompt is the model's to get
        // wrong, and a stale one must not reach another project's row.
        where: { id: input.supersedes, projectId },
        data: { status: "superseded", supersededById: created.id },
      })
      .catch(() => {});
  }

  return created.id;
}

/**
 * The decisions a project still stands by, oldest first.
 *
 * Superseded ones are left out on purpose. The point of handing these to a turn is
 * "this is settled, build on it", and an answer that has already been replaced is
 * the opposite of settled — it would invite the agent to argue with a decision the
 * project has moved past.
 */
export async function activeDecisions(
  projectId: string,
): Promise<ProjectDecisionDto[]> {
  const rows = await database.projectDecision.findMany({
    where: { projectId, status: "active" },
    orderBy: { createdAt: "asc" },
  });

  return rows.map(toDecisionDto);
}

/**
 * The project's log: every turn with what it did, and every decision with why.
 *
 * Assembled from the conversation rather than from the operations, which is the
 * difference between a log and a commit list. A turn that decided *not* to do
 * something committed nothing and is exactly the kind of entry this exists for; a
 * turn that spent its whole budget is one row whose detail holds a hundred.
 *
 * Canvas gestures arrive as turns with no message: one operation each, nobody
 * recorded a reason, and inventing a grouping for them from timestamps would be a
 * guess presented as provenance.
 */
export async function readProjectLog(
  projectId: string,
): Promise<ProjectLogDto> {
  const [messages, operations, decisions] = await Promise.all([
    database.projectChatMessage.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        role: true,
        content: true,
        metadata: true,
        createdAt: true,
      },
    }),
    database.projectOperation.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
      take: OPERATION_LIMIT,
    }),
    database.projectDecision.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: TURN_LIMIT,
    }),
  ]);

  /** Operations of one turn, and the ones that belong to no turn at all. */
  const byMessage = new Map<string, ProjectOperationDto[]>();
  const canvas: Array<{ at: Date; operation: ProjectOperationDto }> = [];

  for (const row of operations) {
    const dto = toOperationDto(row);
    if (!row.chatMessageId) {
      canvas.push({ at: row.createdAt, operation: dto });
      continue;
    }
    byMessage.set(row.chatMessageId, [
      ...(byMessage.get(row.chatMessageId) ?? []),
      dto,
    ]);
  }

  /** The decision a turn served, taken from the operations filed under it. */
  const decisionOfMessage = new Map<string, string>();
  for (const row of operations) {
    if (row.chatMessageId && row.decisionId) {
      decisionOfMessage.set(row.chatMessageId, row.decisionId);
    }
  }

  const turns: ProjectLogTurnDto[] = [];

  for (const [index, message] of messages.entries()) {
    // System rows are the turns that failed before they started; they carry the
    // reason as their content and belong in the log for that.
    if (message.role !== "assistant" && message.role !== "system") continue;

    const previous = messages[index - 1];
    const metadata = readMetadata(message.metadata);

    turns.push({
      chatMessageId: message.id,
      // The prompt is what a reader recognises a turn by, and a turn writes
      // exactly one user message followed by one of its own.
      prompt: previous?.role === "user" ? previous.content : null,
      reply: message.content,
      createdAt: message.createdAt.toISOString(),
      steps: metadata.steps,
      commits: metadata.commits,
      decisionId: decisionOfMessage.get(message.id) ?? null,
      operations: byMessage.get(message.id) ?? [],
    });
  }

  for (const entry of canvas) {
    turns.push({
      chatMessageId: null,
      prompt: null,
      reply: null,
      createdAt: entry.at.toISOString(),
      steps: [],
      commits: entry.operation.commitSha ? [entry.operation.commitSha] : [],
      decisionId: null,
      operations: [entry.operation],
    });
  }

  return {
    turns: turns
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, TURN_LIMIT),
    decisions: decisions.map(toDecisionDto),
  };
}

/**
 * The two fields of an assistant message's metadata the log reads.
 *
 * Validated rather than cast: the column is JSON, and a shape change would reach
 * the browser as a broken render. Same reasoning as `readLiveSteps`.
 */
function readMetadata(value: unknown): {
  steps: AgentStep[];
  commits: string[];
} {
  const empty = { steps: [], commits: [] };
  if (!value || typeof value !== "object" || Array.isArray(value)) return empty;

  const record = value as { steps?: unknown; commits?: unknown };

  const steps = Array.isArray(record.steps)
    ? record.steps.filter((entry): entry is AgentStep => {
        if (!entry || typeof entry !== "object") return false;
        const step = entry as Record<string, unknown>;
        if (step.kind === "thought") return typeof step.text === "string";
        if (step.kind === "tool") {
          return (
            typeof step.tool === "string" && typeof step.summary === "string"
          );
        }
        return false;
      })
    : [];

  const commits = Array.isArray(record.commits)
    ? record.commits.filter((sha): sha is string => typeof sha === "string")
    : [];

  return { steps, commits };
}

function toDecisionDto(row: {
  id: string;
  origin: string;
  question: string;
  context: string;
  choice: string;
  reason: string;
  alternatives: unknown;
  plan: unknown;
  status: string;
  supersededById: string | null;
  createdAt: Date;
}): ProjectDecisionDto {
  return {
    id: row.id,
    origin: row.origin === "user" ? "user" : "agent",
    question: row.question,
    context: row.context,
    choice: row.choice,
    reason: row.reason,
    alternatives: readAlternatives(row.alternatives),
    plan: readPlan(row.plan),
    status: row.status === "superseded" ? "superseded" : "active",
    supersededById: row.supersededById,
    createdAt: row.createdAt.toISOString(),
  };
}

function toOperationDto(row: {
  id: string;
  origin: string;
  mutation: unknown;
  summary: string;
  commitSha: string | null;
  parentSha: string | null;
  createdAt: Date;
}): ProjectOperationDto {
  return {
    id: row.id,
    origin: row.origin === "agent" ? "agent" : "canvas",
    action: actionOf(row.mutation),
    summary: row.summary,
    commitSha: row.commitSha,
    parentSha: row.parentSha,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The mutation's action, dug out of the JSON it was stored as. */
function actionOf(mutation: unknown): string {
  if (mutation && typeof mutation === "object" && !Array.isArray(mutation)) {
    const action = (mutation as Record<string, unknown>).action;
    if (typeof action === "string") return action;
  }
  return "unknown";
}

/**
 * The JSON columns are validated rather than cast.
 *
 * They were written by this app, but a shape change would otherwise reach the
 * browser as a broken render — the same reason `readLiveSteps` revalidates the
 * step trail.
 */
function readAlternatives(value: unknown): DecisionAlternativeDto[] {
  if (!Array.isArray(value)) return [];

  const out: DecisionAlternativeDto[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { option?: unknown; reason?: unknown };
    if (typeof record.option !== "string") continue;
    out.push({
      option: record.option,
      reason: typeof record.reason === "string" ? record.reason : "",
    });
  }
  return out;
}

function readPlan(value: unknown): DecisionPlanDto {
  const empty: DecisionPlanDto = { modules: [], wiring: [] };
  if (!value || typeof value !== "object" || Array.isArray(value)) return empty;

  const record = value as { modules?: unknown; wiring?: unknown };

  const modules = Array.isArray(record.modules)
    ? record.modules.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const item = entry as {
          moduleId?: unknown;
          name?: unknown;
          purpose?: unknown;
        };
        if (typeof item.moduleId !== "string") return [];
        return [
          {
            moduleId: item.moduleId,
            ...(typeof item.name === "string" ? { name: item.name } : {}),
            ...(typeof item.purpose === "string"
              ? { purpose: item.purpose }
              : {}),
          },
        ];
      })
    : [];

  const wiring = Array.isArray(record.wiring)
    ? record.wiring.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const item = entry as {
          target?: unknown;
          targetInput?: unknown;
          source?: unknown;
          sourceOutput?: unknown;
        };
        if (
          typeof item.target !== "string" ||
          typeof item.targetInput !== "string"
        ) {
          return [];
        }
        return [
          {
            target: item.target,
            targetInput: item.targetInput,
            ...(typeof item.source === "string" ? { source: item.source } : {}),
            ...(typeof item.sourceOutput === "string"
              ? { sourceOutput: item.sourceOutput }
              : {}),
          },
        ];
      })
    : [];

  return { modules, wiring };
}
