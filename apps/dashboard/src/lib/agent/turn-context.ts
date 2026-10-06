/**
 * Everything a single agent turn is handed.
 *
 * Its own module because three things need it and they must not need each other:
 * the caller fills it in, `prompt.ts` renders it, and `project-agent.ts` runs the
 * loop over it. With these types living in `project-agent.ts` the prompt could
 * only reach them by importing the loop it is called from — a cycle, and one that
 * would have to be excused as "type-only" rather than fixed.
 *
 * Types only, on purpose. A turn has to be reproducible from its context alone,
 * so what may be read from a database or an API is the caller's business; this
 * only states the shape of the answer.
 */

import type { MCPServerConfig } from "@github/copilot-sdk";
import type { AgentStep, ProjectGraph } from "@/lib/projects/types";
import type { AgentLibraryModule } from "./library-view";
import type { ReasoningEffortValue } from "./settings-service";

/**
 * The linked application repository, ready to read.
 *
 * The credential travels with the repository rather than being looked up where it
 * is used, and that is the point: the token that was proven to read this
 * repository is the one the reads are made with. Carrying it beside the name makes
 * it impossible to have a repository without the access to read it.
 *
 * `branch` is already resolved: the caller turns "no pinned ref" into the
 * repository's current default before the turn starts.
 */
export interface AgentAppRepo {
  fullName: string;
  branch: string;
  /** The provider credential the repository was chosen with. */
  token: string;
}

/** A decision in force, as the prompt states it back to the agent. */
export interface AgentDecision {
  id: string;
  question: string;
  choice: string;
  reason: string;
  /** What was rejected, so the agent does not re-propose it. */
  rejected: string[];
}

/**
 * The result of the last pipeline run on the project's branch.
 *
 * The closest thing to `terraform validate` a turn can see. The real validation
 * runs in the user's own CI, minutes after a commit and outside any turn, so it
 * cannot be waited for — but its verdict on the *previous* turn's work is a fact
 * worth carrying into this one. A model told its last commit failed validation
 * fixes it; a model told nothing builds on top of it.
 */
export interface AgentPipelineCheck {
  name: string;
  /** `queued`, `in_progress`, `completed`. */
  status: string;
  /** `success`, `failure`, `cancelled`, … or null while it is still running. */
  conclusion: string | null;
  htmlUrl: string;
  createdAt: string;
}

export interface AgentContext {
  projectName: string;
  repoFullName: string;
  branch: string;
  graph: ProjectGraph;
  /**
   * The modules this project may place, with their ports.
   *
   * The ports are here for validation and for `describe_module`, not for the
   * prompt: the prompt gets one line per module from
   * `summariseLibraryModule`, in `prompt.ts`. Handing the model every port of every module
   * would spend most of a turn's context on modules it never touches.
   */
  library: AgentLibraryModule[];
  history: Array<{ role: string; content: string }>;
  /**
   * Decisions this project still stands by, oldest first.
   *
   * Structured memory, and the reason it is worth more than the transcript it is
   * derived from. The conversation is replayed newest-first into a character
   * budget, so an answer settled twenty turns ago falls off the end and the agent
   * proposes DocumentDB again. Five lines of decisions survive that, and they say
   * what was rejected as well as what was chosen — which the prose rarely does as
   * plainly.
   */
  decisions?: AgentDecision[];
  /** Identifies the Copilot session; the turn runs as this user. */
  userId: string;
  projectId: string;
  /** The user's GitHub token, which is also what pays for the turn. */
  githubToken: string;
  /**
   * The application this infrastructure is for, when the project names one.
   *
   * Not prompt text like the rest of the context: the repository is somebody's
   * whole codebase and cannot be inlined, so this is a pointer the read tools
   * work from. Null — or a project with no link — means those tools are never
   * registered, and the prompt says the agent has to ask instead.
   */
  appRepo?: AgentAppRepo | null;
  /**
   * That a link exists, whether or not it can be used this turn.
   *
   * Separate from `appRepo` because "linked" and "readable" are different facts
   * and lead to different sentences. Withheld by the user, unreachable on GitHub,
   * and never linked at all are three situations a person fixes on three
   * different screens, so the prompt has to be able to tell them apart.
   */
  appRepoLink?: { fullName: string } | null;
  /** Why the link above could not be used, when that is the reason it is absent. */
  appRepoProblem?: string | null;
  /**
   * The resource types a set of library modules creates, looked up on demand.
   *
   * A callback rather than data, for the same reason the app repository is a
   * pointer: a module is tens of resource rows, and the library is hundreds of
   * modules. `describe_module` asks about the two or three a turn cares about.
   * Absent means the cost section of an answer is simply left out — this module has
   * no database access of its own and must keep working without one.
   */
  moduleResources?: (
    moduleIds: string[],
  ) => Promise<Record<string, Array<{ kind: string; resourceType: string }>>>;
  /** How the last pipeline run on this branch ended, when it can be read. */
  lastCheck?: AgentPipelineCheck | null;
  /** What this user told the agent about how they work. */
  instructions?: string;
  /**
   * Knowledge sources withheld from this turn.
   *
   * The caller has already emptied the corresponding fields — `library` is `[]`
   * when the library is withheld, and `graph` carries no nodes when the
   * repository is. This list exists so the prompt can *say* the data is absent
   * by choice; without it the model reads an empty project as a new one and
   * cheerfully starts building on top of whatever is really there.
   */
  disabledKnowledge?: string[];
  /** Remote MCP servers this user enabled, decrypted and ready to use. */
  mcpServers?: Record<string, MCPServerConfig>;
  /** Copilot model id, or null to let Copilot choose. */
  model?: string | null;
  /**
   * How hard the model should think, when it supports the setting. Typed from
   * our own validated union because the SDK declares `ReasoningEffort` but does
   * not re-export it from the package root.
   */
  reasoningEffort?: ReasoningEffortValue | null;
  /** Tools the agent may not call in this project. */
  disabledTools?: string[];
  /**
   * The operating rules to put at the top of the prompt, already rendered.
   *
   * Passed in rather than read here because this module has no database access,
   * and because a turn must be reproducible from its context alone. Omitted falls
   * back to the code defaults, which is what keeps the agent working when the
   * curation table is unreachable.
   */
  operatingRules?: string[];
  /**
   * Model-facing tool descriptions, by tool name, overriding the catalogue.
   *
   * Only the description: the name and the JSON schema stay in code, because a
   * renamed tool or a broken schema fails in ways nobody sees until a turn
   * misbehaves.
   */
  toolDescriptions?: Record<string, string>;
  /**
   * Whether the agent may delete things.
   *
   * The prompt used to say "ask before doing anything destructive", which was a
   * request the model could decline and nothing more — permission prompts are
   * auto-approved here, because the turn runs headless. Off, the two destructive
   * operations are simply not registered, so this is a capability the agent does
   * not have rather than a rule it is trusted to follow.
   */
  allowDestructive?: boolean;
  /** How long this turn may run, in seconds. Null → the default. */
  turnTimeout?: number | null;
  /**
   * The per-turn budgets, or null for the defaults.
   *
   * Passed in rather than read from the constants for the same reason the
   * operating rules are: a turn has to be reproducible from its context alone,
   * and the rules quote the operation budget — a number the prompt states and the
   * code enforces must come from one place or they will eventually disagree.
   */
  maxToolCalls?: number | null;
  maxMcpCalls?: number | null;
  /**
   * Characters of this project's conversation to replay, or null for the default.
   *
   * The agent's whole long-term memory, so it is the caller's to decide: the
   * transcript lives in their database, not here.
   */
  historyBudgetChars?: number | null;
  /**
   * How many entries of this turn to record, or null for the default.
   *
   * A cap on the record. The reasoning-summary cap rides along with it through
   * `maxThoughtsFor` rather than being passed separately, so the two cannot
   * be handed in contradicting each other.
   */
  maxSteps?: number | null;
  /**
   * The application-repository caps, or null for the defaults.
   *
   * The reads are a per-turn budget like the operations and the MCP calls; the
   * other two bound one call each. All three are the caller's because the linked
   * repository is, and because the requests are made on their rate limit.
   */
  maxAppRepoReads?: number | null;
  appRepoTreeLimit?: number | null;
  appRepoFileChars?: number | null;
  /**
   * Called whenever the trail grows, with the whole trail so far.
   *
   * A turn that builds a stack can run for minutes, and until it returned the UI
   * had nothing to show but a spinner — indistinguishable from a hang. The caller
   * decides where to put the progress; this only reports it. Errors thrown here
   * would kill a working turn, so the caller must swallow its own.
   */
  onStep?: (steps: AgentStep[]) => void;

  /**
   * Fires when the user asked for this turn to stop.
   *
   * Owned by the caller because the request that presses Stop is a different
   * request from this one: only the caller can watch for it, and only it knows
   * where the answer is kept. What this side does with it is abort the runtime
   * session and throw `TurnCancelled`, so the queued edits are dropped
   * instead of committed.
   */
  signal?: AbortSignal;
}
