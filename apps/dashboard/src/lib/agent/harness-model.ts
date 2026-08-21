/**
 * The harness, described once.
 *
 * A harness is everything around the model: what is sent with the request, what
 * the model is told, what it can do, who checks its decisions, who decides when
 * to stop, what survives the turn, and what is written down. This module names
 * those planes and places every part of our agent on exactly one of them.
 *
 * Why the plane matters more than the list. The same rule is worth very different
 * amounts depending on where it lives: "never delete anything" as a sentence in
 * the prompt is a request the model may decline, as an unregistered tool it is
 * impossible, and as a counter that only logs it is nothing at all. Grouping by
 * plane makes that visible, and the earlier version of this screen is why it has
 * to be — it listed a recording cap and a wait timeout under "Guardrails", which
 * read as limits on the agent when neither one stopped it from doing anything.
 *
 * Each entry carries `enforcement`, which says how it reaches the model, and
 * `source`, which names the code that implements it so a reader can check the
 * claim instead of believing this screen.
 *
 * Two texts per entry, on purpose. `brief` is for the diagram, where a box is
 * three lines tall and a sentence that wraps past two is cut mid-word; the longer
 * `description` is for the card, where there is room to be precise. One text
 * serving both was the reason the diagram looked truncated.
 *
 * No `server-only`: it is a catalogue of labels with no secrets and no database
 * access, and the settings UI has to render the same description the agent is
 * actually built from.
 */

import {
  AGENT_HISTORY_BUDGET_CHARS,
  AGENT_MAX_STEPS,
  AGENT_MAX_TOOL_CALLS,
} from "./runtime-options";

/** The planes, in the order a turn passes through them. */
export type HarnessPlane =
  | "config"
  | "context"
  | "actions"
  | "mediation"
  | "control"
  | "state"
  | "observability";

/**
 * How a part of the harness actually reaches the model.
 *
 * Ordered from strongest to weakest, which is also the order to prefer when
 * implementing something new: if a rule can be made impossible rather than
 * requested, it should be.
 */
export type HarnessEnforcement =
  | "capability"
  | "provider-config"
  | "mediated"
  | "control-loop"
  | "prompt"
  | "recorded";

export interface EnforcementMeta {
  label: string;
  /** Whether it constrains the model, merely asks it, or only observes it. */
  strength: "enforced" | "advisory" | "observed";
  explanation: string;
}

export const HARNESS_ENFORCEMENT: Record<HarnessEnforcement, EnforcementMeta> =
  {
    capability: {
      label: "Capability",
      strength: "enforced",
      explanation:
        "Enforced by absence. What is not registered cannot be called, so there is nothing to obey or ignore.",
    },
    "provider-config": {
      label: "Request config",
      strength: "enforced",
      explanation:
        "Sent with the request itself. The model answers within it rather than deciding about it.",
    },
    mediated: {
      label: "Checked per call",
      strength: "enforced",
      explanation:
        "Our code runs between the model's decision and its effect, and can refuse.",
    },
    "control-loop": {
      label: "Control loop",
      strength: "enforced",
      explanation:
        "The loop around the model decides, so a model that will not stop is stopped.",
    },
    prompt: {
      label: "Prompt text",
      strength: "advisory",
      explanation:
        "Text in the prompt. It shapes what the model does but cannot compel it.",
    },
    recorded: {
      label: "Recorded only",
      strength: "observed",
      explanation:
        "Written down so you can read it back. It does not constrain the turn.",
    },
  };

export interface HarnessPlaneMeta {
  id: HarnessPlane;
  label: string;
  /** What this plane is, in one line. Short enough for a diagram box. */
  summary: string;
  /** How things on it are integrated, in the concrete terms of this codebase. */
  integration: string;
}

export const HARNESS_PLANES: readonly HarnessPlaneMeta[] = [
  {
    id: "config",
    label: "Request Configuration",
    summary: "Fixed at the API boundary, before the model sees anything.",
    integration:
      "Fields on the session we create: the model, how hard it thinks, which tool namespaces exist, whose identity the turn runs as.",
  },
  {
    id: "context",
    label: "Context",
    summary: "What the model is told, rebuilt for every turn.",
    integration:
      "Text in the system prompt. Advisory by nature — but a source switched off is left out entirely, and absence is not advisory.",
  },
  {
    id: "actions",
    label: "Action Space",
    summary: "Everything it can do. It cannot act any other way.",
    integration:
      "Tools registered on the session. One that is not registered does not exist for that turn.",
  },
  {
    id: "mediation",
    label: "Mediation",
    summary: "What happens between a decision and its effect.",
    integration:
      "Our handlers: they validate arguments, may refuse, and queue an edit instead of performing it. Nothing reaches the repository without passing through here.",
  },
  {
    id: "control",
    label: "Control Loop",
    summary: "Who decides when the turn ends.",
    integration:
      "Budgets and timeouts held outside the model, plus the session teardown that stops work already in flight.",
  },
  {
    id: "state",
    label: "State & Memory",
    summary: "What outlives the turn, and where the truth is kept.",
    integration:
      "Our database and your Git repository. The runtime session is deleted afterwards, so the model keeps nothing.",
  },
  {
    id: "observability",
    label: "Observability",
    summary: "What is written down, so the rest can be checked.",
    integration:
      "The step trail, the commit history, and the operation log. None of it constrains a turn; all of it is how you find out what one did.",
  },
];

/** The settings fields a plane's entries can be governed by. */
export type HarnessSetting =
  | "model"
  | "reasoningEffort"
  | "turnTimeout"
  | "disabledKnowledge"
  | "disabledTools"
  | "allowDestructive"
  | "instructions";

export interface HarnessElement {
  id: string;
  plane: HarnessPlane;
  label: string;
  /** Diagram text. Kept under ~80 characters so a node never clips. */
  brief: string;
  /** Card text, where there is room to be exact. */
  description: string;
  enforcement: HarnessEnforcement;
  /** The setting that governs it, when there is one. Absent means fixed. */
  setting?: HarnessSetting;
  /** Where it lives in the code, so the claim above can be verified. */
  source: string;
}

/**
 * Everything the harness is made of.
 *
 * Deliberately including the parts nobody can change: a screen that only showed
 * switches would suggest the unswitchable parts do not exist, and those are the
 * ones carrying the most weight.
 */
export const HARNESS_ELEMENTS: readonly HarnessElement[] = [
  // --- Request configuration ----------------------------------------------
  {
    id: "model",
    plane: "config",
    label: "Model and thinking effort",
    brief: "Which model runs the turn, and how hard it thinks.",
    description:
      "Which model runs the turn and how hard it thinks. Sent when the session is created; an effort a model does not support makes it refuse the session rather than quietly ignore the setting.",
    enforcement: "provider-config",
    setting: "model",
    source: "project-agent.ts → client.createSession",
  },
  {
    id: "identity",
    plane: "config",
    label: "Your Copilot identity",
    brief: "The turn runs on your own seat, billed and rate-limited as you.",
    description:
      "The turn runs on your own GitHub token, so it is billed to you, rate-limited as you, and subject to your organisation's Copilot policies. No shared service account exists to inherit.",
    enforcement: "provider-config",
    source: "project-agent.ts → gitHubToken, per session",
  },
  {
    id: "tool-namespaces",
    plane: "config",
    label: "Tool namespaces",
    brief: "The session sees our tools only, never the runtime's own.",
    description:
      "The session may only see our own tools. Even if the runtime gains new built-ins, they are not offered to this session.",
    enforcement: "provider-config",
    source: 'project-agent.ts → availableTools: ["custom:*"]',
  },
  {
    id: "no-retrieval",
    plane: "config",
    label: "Retrieval switched off",
    brief: "The shared embedding cache is disabled for our sessions.",
    description:
      "One runtime process serves every user, and its embedding cache is shared, so semantic retrieval is disabled for our sessions. Belt and braces rather than a load-bearing control: we hand the runtime no checkout, so there is nothing indexed to retrieve.",
    enforcement: "provider-config",
    source: "project-agent.ts → skipEmbeddingRetrieval: true",
  },

  // --- Context -------------------------------------------------------------
  {
    id: "operating-rules",
    plane: "context",
    label: "Operating rules",
    brief: "Edit only through operations, keep replies short.",
    description:
      "Edit only through operations, never answer with HCL instead of making a change, keep replies short. Fixed, and advisory: they shape the answer but do not constrain what the agent can reach.",
    enforcement: "prompt",
    source: "project-agent.ts → systemPrompt",
  },
  {
    id: "repo",
    plane: "context",
    label: "Project repository",
    brief: "Modules, variables, wiring and unfilled inputs on the branch.",
    description:
      "The Terraform already on the branch: module blocks, variables, wiring, and the required inputs nobody has filled in. Switched off, the prompt is built without it and the agent cannot see what exists.",
    enforcement: "prompt",
    setting: "disabledKnowledge",
    source: "knowledge.ts → project-repo",
  },
  {
    id: "library",
    plane: "context",
    label: "Module library",
    brief:
      "The modules it may place, one line each: what it is, how many ports.",
    description:
      "The modules available to place, summarised one line each — name, description, tags and port counts — with the full ports available on request through Describe Module. Switching it off withholds the operations that place and look up a module too, because a tool that can only fail is worse than an absent one.",
    enforcement: "prompt",
    setting: "disabledKnowledge",
    source: "library-view.ts → summariseLibraryModule",
  },
  {
    id: "ports",
    plane: "context",
    label: "Ports and candidates",
    brief: "Each module's inputs and outputs, and what could fill each gap.",
    description:
      "Every placed module's inputs — with their types, which are required, and what each one currently holds — and its outputs. Unfilled required inputs come with both halves of the answer: outputs already on the canvas that would fit, and library modules that would produce one once added. Without this the agent could see that a module existed and not what it had, so an optional input was unsettable.",
    enforcement: "prompt",
    source: "project-agent.ts → describePorts, graph.ts → computeGaps",
  },
  {
    id: "pipeline",
    plane: "context",
    label: "Last pipeline result",
    brief: "Whether the branch last passed `terraform validate` in your CI.",
    description:
      "How the newest workflow run on this branch ended. It is the only verdict from a real Terraform the agent ever sees: the pipeline runs `fmt`, `init` and `validate` on every commit, minutes later and outside any turn, so it arrives as a fact about the previous turn's work rather than this one's. Absent when the installation cannot read Actions, which is not an error.",
    enforcement: "prompt",
    source: "chat/route.ts → readLastCheck",
  },
  {
    id: "instructions",
    plane: "context",
    label: "Your instructions",
    brief: "Your standing preferences, added to every turn.",
    description:
      "Your standing preferences, added to every turn across all projects. Advisory, like every other sentence in a prompt.",
    enforcement: "prompt",
    setting: "instructions",
    source: "settings-service.ts → instructions",
  },

  // --- Action space --------------------------------------------------------
  {
    id: "operations",
    plane: "actions",
    label: "Operations",
    brief: "The edits it can make. One switched off is not registered.",
    description:
      "Everything the agent can do to a project: the edits to modules and variables, the lookups that tell it what a module has, and the review that tells it what its own queued edits add up to. An operation switched off is not registered on the session, so the agent cannot call it and is told in the prompt that it is unavailable — rather than trying and failing.",
    enforcement: "capability",
    setting: "disabledTools",
    source: "tool-catalogue.ts, project-agent.ts → buildTools",
  },
  {
    id: "sandbox",
    plane: "actions",
    label: "No shell, no filesystem",
    brief: "No command, no file on this server, no request of its own.",
    description:
      "The client is created in a mode that registers none of the runtime's own tools, so the session has no way to run a command, read a file on this server, or make a request of its own.",
    enforcement: "capability",
    source: 'copilot.ts → mode: "empty"',
  },
  {
    id: "no-git-writes",
    plane: "actions",
    label: "No Git writes",
    brief:
      "No tool writes to a repository. Reads are limited to one, read-only.",
    description:
      "No tool writes to any repository. Everything the agent changes in the project goes through the queue below, and the only repository it can read is the application repository a project explicitly links — with two read-only tools, capped per turn, and only while that knowledge source is on. Nothing else on GitHub is reachable.",
    enforcement: "capability",
    source: "project-agent.ts → buildTools: list_app_files, read_app_file",
  },

  // --- Mediation -----------------------------------------------------------
  {
    id: "validation",
    plane: "mediation",
    label: "Arguments checked on arrival",
    brief: "A bad name or unknown module is refused with a reason.",
    description:
      "A call naming a module that does not exist, a name already taken, or a library id we cannot find is refused with a reason the model can act on in the same turn — not after a commit.",
    enforcement: "mediated",
    source: "project-agent.ts → refuse()",
  },
  {
    id: "port-validation",
    plane: "mediation",
    label: "Ports and types checked on arrival",
    brief:
      "An input or output name no module declares is refused, with a guess.",
    description:
      "A connection is checked port by port, not just block by block: an output the source does not expose, an argument the target never declared, or a literal whose shape cannot match the declared type is refused with the closest real name. This is the class of mistake that used to reach the repository silently — Terraform only objects at plan time, long after the turn that wrote it.",
    enforcement: "mediated",
    source: "project-agent.ts → checkInput, checkOutput; type-check.ts",
  },
  {
    id: "projection",
    plane: "mediation",
    label: "Queued edits projected",
    brief: "Each check runs against the project as the queue will leave it.",
    description:
      "Because edits are queued rather than applied, every check runs against a projection: the graph the turn started with, plus each queued mutation replayed in memory. That is what lets a module added ten calls ago be wired correctly, and what Review Project reports on. It mirrors the mutation path closely enough to name the same block a collision will rename.",
    enforcement: "mediated",
    source: "graph-projection.ts → GraphProjection",
  },
  {
    id: "queue",
    plane: "mediation",
    label: "Plan, then apply",
    brief: "Operations queue an edit; the app commits the queue afterwards.",
    description:
      "An operation does not change anything. It queues an edit, and the app applies the queue after the turn as the same mutation a manual canvas edit makes, then commits once. The privilege sits in our code, never in the model's hands.",
    enforcement: "mediated",
    source: "chat/route.ts → applyProjectMutation after the turn",
  },
  {
    id: "destructive",
    plane: "mediation",
    label: "Destructive operations",
    brief: "Off by default: deleting is a capability it does not have.",
    description:
      "Removing a module or a variable deletes the block and every reference to it. Off by default: when it is off the two operations are not registered at all, so this is a capability the agent lacks rather than a rule it is asked to respect.",
    enforcement: "capability",
    setting: "allowDestructive",
    source: "project-agent.ts → DESTRUCTIVE_TOOLS",
  },

  // --- Control loop --------------------------------------------------------
  {
    id: "tool-budget",
    plane: "control",
    label: "Operation budget",
    brief: `At most ${AGENT_MAX_TOOL_CALLS} operations per turn; the next one is refused.`,
    description: `At most ${AGENT_MAX_TOOL_CALLS} operations in one turn. The next call is refused with a message saying the budget is spent, so the model reports back instead of looping. Not a setting: raising it only lets one turn make a change nobody reviewed.`,
    enforcement: "control-loop",
    source: "project-agent.ts → queue() checks the budget",
  },
  {
    id: "timeout",
    plane: "control",
    label: "Turn timeout",
    brief: "On expiry the request is aborted and nothing is committed.",
    description:
      "How long a turn may run. On expiry the request is aborted and the session deleted, so work in flight stops rather than continuing unwatched. Nothing is committed: a turn that ran out of time leaves the repository as it was.",
    enforcement: "control-loop",
    setting: "turnTimeout",
    source: "project-agent.ts → session.abort() then deleteSession",
  },
  {
    id: "plan-first",
    plane: "control",
    label: "Plan before building",
    brief: "A large plan ends the turn and waits for your next message.",
    description:
      "For anything beyond a single edit the agent states its plan first, and a plan adding more than a handful of modules is meant to end the turn so you can confirm it. Advisory rather than enforced, and honestly so: the turn runs headless, so there is nobody to answer a question mid-turn — the confirmation can only arrive as your next message.",
    enforcement: "prompt",
    source: "project-agent.ts → propose_plan, PLAN_CONFIRM_THRESHOLD",
  },
  {
    id: "fresh-session",
    plane: "control",
    label: "One session per turn",
    brief: "Each turn gets its own session, deleted when it ends.",
    description:
      "Every turn creates its own runtime session and deletes it afterwards. Our transcript in Postgres is what makes the conversation continuous, so nothing depends on runtime state that could expire mid-thought.",
    enforcement: "control-loop",
    source: "project-agent.ts → sessionId per turn, finally deleteSession",
  },

  // --- State & memory ------------------------------------------------------
  {
    id: "transcript",
    plane: "state",
    label: "Project conversation",
    brief: `Replayed newest-first, up to ~${Math.round(AGENT_HISTORY_BUDGET_CHARS / 1000)}k characters.`,
    description: `This project's own chat, kept in our database and replayed newest-first into every turn, up to about ${Math.round(AGENT_HISTORY_BUDGET_CHARS / 1000)}k characters. A budget rather than a message count, because eight short answers and eight long ones are not the same amount of context.`,
    enforcement: "control-loop",
    source: "chat/route.ts → HISTORY_QUERY, recallConversation",
  },
  {
    id: "git",
    plane: "state",
    label: "Git as the source of truth",
    brief: "Every change is an ordinary commit you can revert.",
    description:
      "The project is its repository. Every change the agent makes is an ordinary commit you can read, revert or ignore, and nothing about the project lives only inside the agent.",
    enforcement: "mediated",
    source: "projects/service.ts → applyProjectMutation",
  },

  // --- Observability -------------------------------------------------------
  {
    id: "steps",
    plane: "observability",
    label: "Step trail",
    brief: `Thoughts and operations, capped at ${AGENT_MAX_STEPS} entries.`,
    description: `The reasoning summaries and operations of a turn, written while it runs so a long turn shows progress, then stored with the reply. Capped at ${AGENT_MAX_STEPS} entries — a cap on the record, not on the turn, which is what the operation budget above is for.`,
    enforcement: "recorded",
    source: "project-agent.ts → pushStep, Project.agentSteps",
  },
  {
    id: "history",
    plane: "observability",
    label: "Operation history",
    brief: "Every applied change with its commit, on the History tab.",
    description:
      "Every applied change, with the commit it produced, on the project's History tab. The agent's edits and your own appear the same way, because they are the same mutations.",
    enforcement: "recorded",
    source: "ProjectOperation, history-panel.tsx",
  },
];

export function elementsOnPlane(plane: HarnessPlane): HarnessElement[] {
  return HARNESS_ELEMENTS.filter((element) => element.plane === plane);
}
