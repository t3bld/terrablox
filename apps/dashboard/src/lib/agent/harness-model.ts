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
 * That plane is called Guardrails again, deliberately. The lesson was never about
 * the word, which is the one people actually think in; it was about what got filed
 * under it. So the rule that replaced it is the `enforcement` field below: a box
 * only sits on Guardrails if it genuinely stands between a decision and its
 * effect, and anything weaker says so on its own badge wherever it lives.
 *
 * The shape is a spine with things hanging off it: provider, model, agent loop.
 * Everything else hangs off the loop, because the loop is what consumes it — each
 * pass assembles context, offers the tools, checks a call, carries memory in,
 * and writes the trail. See {@link HarnessAnchor}.
 *
 * The organising principle is *mechanism*, not topic: which of the seven ways of
 * reaching the model this part uses. That is why the user's standing instructions
 * sit under Memory rather than Context even though they arrive as prompt text —
 * their mechanism is "stored by us and replayed into every turn", which is the
 * transcript's mechanism exactly, and not the mechanism of a project fact that is
 * rebuilt from the repository each time.
 *
 * This module is the single source for both the diagram and the settings cards.
 * Both read `label`, so a heading on a card and a box in the graph cannot say
 * different things — they used to, because the cards carried hand-written
 * headings ("Limits", "Permission") that matched no element at all, which left a
 * reader no way to tell which switch belonged to which part of the harness.
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
  KNOWLEDGE_APP_REPO,
  KNOWLEDGE_MODULE_LIBRARY,
  KNOWLEDGE_PROJECT_REPO,
} from "./knowledge";
import {
  AGENT_HISTORY_BUDGET_CHARS,
  AGENT_MAX_MCP_CALLS,
  AGENT_MAX_TOOL_CALLS,
} from "./runtime-options";

/**
 * The systems the harness sits between, which are not part of it.
 *
 * One, now: the provider the inference runs on, above everything else because that
 * is where a turn comes from and it is not ours to configure.
 *
 * The repository used to be drawn below as the second endpoint. It came out because
 * a box has to earn its place: it had no settings, opened no panel, and what it
 * said — every change lands as an ordinary commit, after the turn, through
 * Guardrails — is already the content of the "Plan, then apply" element, said there
 * next to the code that does it. Two boxes for one fact is how a diagram stops
 * being read.
 *
 * Kept out of {@link HARNESS_PLANES} because it is not a way of reaching the model,
 * it is the far end of the wire.
 */
export type HarnessExternal = "provider";

export interface HarnessExternalMeta {
  id: HarnessExternal;
  label: string;
  /** Diagram text, held to the same length as an element's `brief`. */
  brief: string;
  /** Card text. */
  description: string;
}

export const HARNESS_EXTERNALS: readonly HarnessExternalMeta[] = [
  {
    id: "provider",
    label: "Provider",
    brief: "Runs the turn on your own Copilot seat, billed and limited as you.",
    description:
      "GitHub Copilot runs the inference. We hold no model key of our own: every turn goes out on the signed-in user's token, so it is billed to them, rate-limited as them, and subject to their organisation's policies. Nothing below this line can change that, which is why it is drawn outside the harness rather than as a setting inside it.",
  },
];

/** The parts of the harness, in the order a reader meets them. */
export type HarnessPlane =
  | "model"
  | "loop"
  | "context"
  | "tools"
  | "tools-ours"
  | "tools-mcp"
  | "tools-runtime"
  | "guardrails"
  | "memory"
  | "observability";

/**
 * What a plane hangs off, which is the shape of the whole harness.
 *
 * The spine runs provider → model → agent loop, and everything else hangs off the
 * loop, because the loop is what consumes it: each pass assembles context, offers
 * the tools, checks a call, carries memory in and writes the trail.
 *
 * There is no separate plane for the arguments we send. There was — "Request
 * Configuration", holding the model, the tool namespaces and the retrieval switch —
 * and it grouped three things by the accident of all being fields on
 * `createSession`. The model and its effort are the Model box, so they are on it;
 * the namespaces turned out to be the structure of the Action Space rather than an
 * item in a list; and the retrieval switch is a claim about a shared runtime
 * keeping nothing, which is what Memory's short term is about.
 *
 * One nuance worth keeping straight: the loop is not ours. `sendAndWait` is a
 * single call and the runtime iterates inside it. What we own are its inputs, its
 * per-call hooks, and the budgets that end it — which is why the Agent Loop plane
 * holds limits and not an implementation.
 */
export type HarnessAnchor = HarnessExternal | HarnessPlane;

/**
 * The name of whatever a plane hangs off.
 *
 * Just the name. It used to be a phrase — "Inside the agent loop", "Under Tools" —
 * which read as a sentence where a label belongs, and put the same preposition in
 * front of every box for no information. The badge sits under a heading that
 * already says what this is; all it has to add is where.
 */
export function anchorLabel(anchor: HarnessAnchor): string {
  return (
    HARNESS_EXTERNALS.find((entry) => entry.id === anchor)?.label ??
    HARNESS_PLANES.find((plane) => plane.id === anchor)?.label ??
    anchor
  );
}

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
      label: "Agent loop",
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
  /** What this plane hangs off: an outside system, or another plane. */
  attachesTo: HarnessAnchor;
  /** What this plane is, in one line. Short enough for a diagram box. */
  summary: string;
  /** How things on it are integrated, in the concrete terms of this codebase. */
  integration: string;
}

export const HARNESS_PLANES: readonly HarnessPlaneMeta[] = [
  {
    id: "model",
    label: "Model",
    attachesTo: "provider",
    summary: "Runs at the provider. Yours to choose, not to change.",
    integration:
      "Drawn outside the harness with the provider, because that is where it runs: we do not host it, cannot see inside it, and nothing on this screen alters how it thinks. What is ours is the choice — which model, and how hard it thinks — sent when the session is created, so it answers within them rather than deciding about them. That is why this box has settings while sitting on the outside: the two halves are different things, and the box would be lying if it were drawn as one of our own parts.",
  },
  {
    id: "loop",
    label: "Agent Loop",
    attachesTo: "model",
    summary:
      "Reads, calls a tool, reads the result, repeats. Open it for the sequence.",
    integration:
      "Everything below hangs off this, because the loop is what consumes it: each pass assembles context, offers the tools, checks a call, and records what happened. The loop is not ours to run — `sendAndWait` is one call and the runtime iterates inside it — so what sits on this plane is what ends it: the budgets and the timeout we hold outside the model, plus the session teardown that stops work already in flight.",
  },
  {
    id: "context",
    label: "Context",
    attachesTo: "loop",
    summary: "What the model is told about the project, rebuilt every turn.",
    integration:
      "Text in the system prompt, assembled fresh from the repository and the library on every turn. Advisory by nature — but a source switched off is left out entirely, and absence is not advisory.",
  },
  {
    id: "tools",
    label: "Tools",
    attachesTo: "loop",
    summary: "Everything it can do. Three sources, each switched separately.",
    integration:
      "A Copilot session can hold tools from three sources, and the runtime names them that way: `custom:` for the ones we register, `mcp:` for whatever your servers advertise, `builtin:` for the runtime's own — shell, files, web requests. We hand the session an allow list of those namespaces, and only what matches exists for the turn. Ours are always on it; `mcp:` is added only for a turn where you have a server enabled; `builtin:` never is. The list is not optional decoration: the client runs in a mode where the SDK requires it. Each source is its own box below, because what you decide about them is different — which of our operations to allow, which outside servers to trust, and nothing at all about the runtime's.",
  },
  {
    id: "tools-ours",
    label: "Operations",
    attachesTo: "tools",
    summary:
      "Written by us, checked by us, and the only ones that edit a project.",
    integration:
      "Registered from `tool-catalogue.ts`, with handlers in our own code. These are the only tools that change anything: each one queues an edit rather than performing it, and every call passes through Guardrails on the way. A switched-off operation is not registered at all.",
  },
  {
    id: "tools-mcp",
    label: "MCP servers",
    attachesTo: "tools",
    summary: "Outside tools you connect. Nothing is enabled until you say so.",
    integration:
      "Remote servers speaking the Model Context Protocol, connected by you. We ask each one what tools it has and list them, so a server is not all-or-nothing. They are somebody else's code, run by the runtime: they do not pass through Guardrails and they cannot change your project, which is why they are budgeted and recorded on their own.",
  },
  {
    id: "tools-runtime",
    label: "Runtime functions",
    attachesTo: "tools",
    summary: "The runtime's own shell, files and web access. We take none.",
    integration:
      "The Copilot runtime brings functions of its own — a shell, file reads and writes, web requests. This box exists to say that the session is given none of them, which is a stronger statement than any setting on this screen — there is nothing here to switch, because there is nothing registered to switch off.",
  },
  {
    id: "guardrails",
    label: "Guardrails",
    attachesTo: "loop",
    summary: "Checked on every call, before anything takes effect.",
    integration:
      "Our handlers, run on every tool call the loop makes: they validate arguments, may refuse, and queue an edit instead of performing it. Nothing reaches your repository without passing through here. Worth keeping apart from the limits on the Agent Loop above, which are also guardrails in the loose sense: those end the *turn* and are counted once per turn, while these run on every single call and decide whether it happens at all.",
  },
  {
    id: "memory",
    label: "Memory",
    attachesTo: "loop",
    summary: "What the agent carries between turns, and what it forgets.",
    integration:
      "Only what changes from one turn to the next. Short term is what the shared runtime is not allowed to keep: the session is deleted after every turn and its semantic cache is switched off, so nothing of one user's project outlives their turn on a process that serves everybody. Long term is this project's conversation, kept in our own database and replayed into the loop each time it starts. A standing preference is not memory even though we store it, because it is the same on the first turn and the fiftieth; those are on the Context plane with the rest of the prompt text.",
  },
  {
    id: "observability",
    label: "Observability",
    attachesTo: "loop",
    summary: "What is written down, so the rest can be checked.",
    integration:
      "The step trail, written while the loop runs so a long turn shows progress, and the operation log afterwards. None of it constrains a turn; all of it is how you find out what one did.",
  },
];

/**
 * The settings fields a plane's entries can be governed by.
 *
 * Absent from an element means fixed, and the card then states the element rather
 * than offering a control for it.
 */
export type HarnessSetting =
  | "model"
  | "reasoningEffort"
  | "turnTimeout"
  | "maxToolCalls"
  | "maxMcpCalls"
  | "historyBudgetChars"
  | "maxSteps"
  | "maxAppRepoReads"
  | "appRepoTreeLimit"
  | "appRepoFileChars"
  | "disabledKnowledge"
  | "appRepo"
  | "disabledTools"
  | "mcpServers"
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
  /**
   * Further fields the same control writes.
   *
   * For the one element that is a group of related numbers rather than a single
   * dial: how far the agent may read into an application is three caps — the
   * per-turn budget, the size of a listing, the size of a file — and splitting them
   * into three entries would put three near-identical cards on the Context plane
   * to say one thing. Declared so the "this project" badge stays honest, which it
   * would not if it only watched the first of the three.
   */
  extraSettings?: readonly HarnessSetting[];
  /**
   * The knowledge source this element is, for the ones that are one.
   *
   * Declared here rather than matched up in the settings screen so the link exists
   * once. Three elements on the Context plane share the `disabledKnowledge`
   * setting, and without this each surface would need its own copy of "which
   * element means which source" — the kind of duplicate that goes stale the first
   * time a source is renamed.
   */
  knowledgeId?: string;
  /**
   * A heading this element sits under, within its plane.
   *
   * Only where a plane has a real internal division worth showing. Memory has
   * one — what lasts a turn and what lasts longer is the distinction the whole
   * plane is about — and inventing groups for the others would add a layer of
   * headings carrying no information.
   */
  group?: string;
  /** Where it lives in the code, so the claim above can be verified. */
  source: string;
}

/** The sub-headings within Memory, in the order they are shown. */
export const MEMORY_SHORT_TERM = "Short term — within a turn";
export const MEMORY_LONG_TERM = "Long term — across turns";

/**
 * Everything the harness is made of.
 *
 * Deliberately including the parts nobody can change: a screen that only showed
 * switches would suggest the unswitchable parts do not exist, and those are the
 * ones carrying the most weight.
 *
 * Order within a plane is the order both the cards and the diagram use, so this
 * array is also a layout decision. Configurable entries come before fixed ones on
 * each plane: the reader is usually here to change something.
 */
export const HARNESS_ELEMENTS: readonly HarnessElement[] = [
  // --- Model ---------------------------------------------------------------
  {
    id: "model",
    plane: "model",
    label: "Model and thinking effort",
    brief: "Which model runs the turn, and how hard it thinks.",
    description:
      "Which model runs the turn and how hard it thinks. Sent when the session is created; an effort a model does not support makes it refuse the session rather than quietly ignore the setting. The list offered is the one your own Copilot entitlement returns, so it is what you are actually allowed to run rather than a list we maintain.",
    enforcement: "provider-config",
    setting: "model",
    source: "project-agent.ts → client.createSession",
  },

  // --- Context -------------------------------------------------------------
  {
    id: "repo",
    plane: "context",
    label: "Project repository",
    brief: "Modules, variables, wiring and unfilled inputs on the branch.",
    description:
      "The Terraform already on the branch: module blocks, variables, wiring, and the required inputs nobody has filled in. Switched off, the prompt is built without it and the agent cannot see what exists.",
    enforcement: "prompt",
    setting: "disabledKnowledge",
    knowledgeId: KNOWLEDGE_PROJECT_REPO,
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
    knowledgeId: KNOWLEDGE_MODULE_LIBRARY,
    source: "library-view.ts → summariseLibraryModule",
  },
  {
    id: "app-repo",
    plane: "context",
    label: "Application repository",
    brief: "The codebase this infrastructure is for, read on demand.",
    description:
      "The application a project is built for. Unlike everything else on this plane it is a pointer rather than prompt text — a codebase cannot be inlined — so the agent reads it through two capped, read-only operations while this source is on. It reads with the credential the repository was chosen with, not with your Copilot token, so what it can open is exactly what the picker offered. A link belongs to one project, which is why this is the only setting here that has no global default.",
    enforcement: "capability",
    setting: "appRepo",
    knowledgeId: KNOWLEDGE_APP_REPO,
    source: "project-agent.ts → appRepo, knowledge.ts → app-repo",
  },
  {
    id: "app-repo-reads",
    plane: "context",
    label: "How far it reads",
    brief:
      "The reading budget, and how much of a listing or a file comes back.",
    description:
      "How much of the linked application one turn may take in. The reading budget is counted apart from the operation budget, because a read commits nothing — sharing one would mean a turn that studied an application properly had nothing left to build with. It still needs a ceiling of its own: every read is a GitHub request against your rate limit, and a model that has decided to read a whole monorepo has stopped making progress. The other two bound a single call rather than the turn. Raising the listing limit is the right answer for a large repository, where the intended remedy — narrowing the path — needs a first listing broad enough to show which subtree to narrow to. The file limit only ever truncates something whose tail was not going to help, since anything that states what an application needs is far below it. All three share the model\u2019s context window with the project and the module library, so more is not free.",
    enforcement: "capability",
    setting: "maxAppRepoReads",
    extraSettings: ["appRepoTreeLimit", "appRepoFileChars"],
    knowledgeId: KNOWLEDGE_APP_REPO,
    source: "project-agent.ts \u2192 spendRead, list_app_files, read_app_file",
  },
  {
    id: "instructions",
    plane: "context",
    label: "Your instructions",
    brief: "Your standing preferences, added to every turn of every project.",
    description:
      "Your standing preferences, stored once and added to every turn across all of your projects. Here rather than under Memory, which is where they used to sit: Memory is what carries from one turn to the next, and these do not — they are identical on the first turn and the fiftieth. Being stored is how they are plumbed, not how they reach the model; the mechanism is prompt text, the same as everything else on this plane, and by the storage argument the module library would belong under Memory too. Advisory, like every other sentence in a prompt.",
    enforcement: "prompt",
    setting: "instructions",
    source: "settings-service.ts → instructions",
  },
  {
    id: "record-language",
    plane: "context",
    label: "Recorded in English",
    brief:
      "Decisions, plans and replies are written in English whatever you write in.",
    description:
      "Everything the agent produces is written in English — the decisions it records, the plans inside them, its summaries and its replies — regardless of the language of the conversation. Your own words are never rewritten, and it may quote them. The reason is the log: a decision record is documentation that outlives the conversation it came from, and a project whose reasons are half in one language and half in another cannot be read by the next person or searched by anyone. Part of the operating rules, so an administrator can change it.",
    enforcement: "prompt",
    source: "runtime-options.ts → DEFAULT_OPERATING_RULES",
  },
  {
    id: "operating-rules",
    plane: "context",
    label: "Operating rules",
    brief: "Edit only through operations, keep replies short.",
    description:
      "Edit only through operations, never answer with HCL instead of making a change, keep replies short. Editable by an administrator rather than per user, and advisory: they shape the answer but do not constrain what the agent can reach.",
    enforcement: "prompt",
    source: "runtime-options.ts → DEFAULT_OPERATING_RULES, harness-curation.ts",
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

  // --- Tools ---------------------------------------------------------------
  {
    id: "operations",
    plane: "tools-ours",
    label: "Registered operations",
    brief: "The edits it can make. One switched off is not registered.",
    description:
      "Everything the agent can do to a project: the edits to modules and variables, the lookups that tell it what a module has, and the review that tells it what its own queued edits add up to. An operation switched off is not registered on the session, so the agent cannot call it and is told in the prompt that it is unavailable — rather than trying and failing. These are ours: the schema is in our code, the handler is our code, and every one of them passes through Guardrails below.",
    enforcement: "capability",
    setting: "disabledTools",
    source: "tool-catalogue.ts, project-agent.ts → buildTools",
  },
  {
    id: "no-git-writes",
    plane: "tools-ours",
    label: "No Git writes",
    brief:
      "No tool writes to a repository. Reads are limited to one, read-only.",
    description:
      "No tool writes to any repository. Everything the agent changes in the project goes through the queue below, and the only repository it can read is the application repository a project explicitly links — with two read-only tools, capped per turn, and only while that knowledge source is on. Nothing else on GitHub is reachable.",
    enforcement: "capability",
    source: "project-agent.ts → buildTools: list_app_files, read_app_file",
  },
  {
    id: "mcp-servers",
    plane: "tools-mcp",
    label: "Connect a server",
    brief: "Outside tools you connect, switchable one by one.",
    description:
      "Remote MCP servers you connect yourself — a vendor's documentation, an internal catalogue, anything that speaks the protocol. We ask each server what tools it has, and each connected server gets a box of its own where every tool has its own switch — so a server is not all-or-nothing, and the ones left off are not offered to the session. Only https, only public addresses, and any auth headers are encrypted at rest and never sent back to the browser. Unlike an operation these are somebody else's code, executed by the runtime: they do not pass through Guardrails and they do not queue a change to your project, so they are budgeted and recorded separately.",
    enforcement: "capability",
    setting: "mcpServers",
    source:
      "settings-service.ts → mcpServersForSession, mcp-client.ts → listMcpTools",
  },
  {
    id: "sandbox",
    plane: "tools-runtime",
    label: "None taken",
    brief: "No command, no file on this server, no request of its own.",
    description:
      "The runtime brings its own tools — a shell, file reads and writes, web requests — and this session is given none of them. Two things say so: the client is created in a mode that registers no built-ins, and the session's allow list names only the other two namespaces, so a built-in that appeared in a later runtime version still would not match. The agent therefore has no way to run a command, read a file on this server, or make a request of its own; the only outside addresses it can reach are the MCP servers you connected.",
    enforcement: "capability",
    source: 'copilot.ts → mode: "empty"; project-agent.ts → availableTools',
  },

  // --- Guardrails ----------------------------------------------------------
  {
    id: "destructive",
    plane: "guardrails",
    label: "Destructive operations",
    brief: "Off by default: deleting is a capability it does not have.",
    description:
      "Removing a module or a variable deletes the block and every reference to it. Off by default: when it is off the two operations are not registered at all, so this is a capability the agent lacks rather than a rule it is asked to respect.",
    enforcement: "capability",
    setting: "allowDestructive",
    source: "project-agent.ts → DESTRUCTIVE_TOOLS",
  },
  {
    id: "validation",
    plane: "guardrails",
    label: "Arguments checked on arrival",
    brief: "A bad name or unknown module is refused with a reason.",
    description:
      "A call naming a module that does not exist, a name already taken, or a library id we cannot find is refused with a reason the model can act on in the same turn — not after a commit.",
    enforcement: "mediated",
    source: "project-agent.ts → refuse()",
  },
  {
    id: "port-validation",
    plane: "guardrails",
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
    plane: "guardrails",
    label: "Queued edits projected",
    brief: "Each check runs against the project as the queue will leave it.",
    description:
      "Because edits are queued rather than applied, every check runs against a projection: the graph the turn started with, plus each queued mutation replayed in memory. That is what lets a module added ten calls ago be wired correctly, and what Review Project reports on. It mirrors the mutation path closely enough to name the same block a collision will rename.",
    enforcement: "mediated",
    source: "graph-projection.ts → GraphProjection",
  },
  {
    id: "queue",
    plane: "guardrails",
    label: "Plan, then apply",
    brief: "Operations queue an edit; the app commits the queue afterwards.",
    description:
      "An operation does not change anything. It queues an edit, and the app applies the queue after the turn as the same mutation a manual canvas edit makes, then commits once. That commit is the only moment anything the agent did reaches your Git repository, and it is an ordinary commit: readable, revertible, indistinguishable from a manual canvas edit. The privilege sits in our code, never in the model's hands.",
    enforcement: "mediated",
    source: "chat/route.ts → applyProjectMutation after the turn",
  },

  // --- Agent loop ----------------------------------------------------------
  {
    id: "timeout",
    plane: "loop",
    label: "Turn timeout",
    brief: "On expiry the request is aborted and nothing is committed.",
    description:
      "How long a turn may run. On expiry the request is aborted and the session deleted, so work in flight stops rather than continuing unwatched. Nothing is committed: a turn that ran out of time leaves the repository as it was.",
    enforcement: "control-loop",
    setting: "turnTimeout",
    source: "project-agent.ts → session.abort() then deleteSession",
  },
  {
    id: "tool-budget",
    plane: "loop",
    label: "Operation budget",
    brief: "How many operations one turn may queue; the next one is refused.",
    description: `How many operations one turn may queue, ${AGENT_MAX_TOOL_CALLS} by default. The call past the limit is refused with a message saying the budget is spent, so the model reports back instead of looping. This is the size of the largest change one unreviewed turn can make, because every queued operation becomes a commit afterwards — so lowering it is the cautious direction, and setting it to 1 makes the agent stop and report after every single edit. The number is also stated in the prompt, from this same setting, so what the agent is told and what the code allows cannot drift apart.`,
    enforcement: "control-loop",
    setting: "maxToolCalls",
    source: "project-agent.ts → queue() checks the budget",
  },
  {
    id: "mcp-budget",
    plane: "loop",
    label: "MCP call budget",
    brief: "How many MCP calls one turn may make, counted on its own.",
    description: `How many calls to your MCP servers one turn may make, ${AGENT_MAX_MCP_CALLS} by default, counted separately from the operation budget. Separate because the two are different risks: an operation becomes a commit, while an MCP call is a request to somebody else's server on your credential — reading widely is legitimate, looping is not. The call past the limit is refused with a reason the model can report, so a server that keeps answering "nearly" cannot spend the whole timeout. Worth raising only for a server whose answers are genuinely paginated.`,
    enforcement: "control-loop",
    setting: "maxMcpCalls",
    source: "project-agent.ts → onPermissionRequest",
  },
  {
    id: "plan-first",
    plane: "loop",
    label: "Decide before building",
    brief: "A large plan ends the turn and waits for your next message.",
    description:
      "For anything beyond a single edit the agent records what it decided and why before building, and a plan adding more than a handful of modules is meant to end the turn so you can confirm it. Advisory rather than enforced, and honestly so: the turn runs headless, so there is nobody to answer a question mid-turn — the confirmation can only arrive as your next message. The record itself is not advisory: it lands in the project's Log with the operations it produced.",
    enforcement: "prompt",
    source: "project-agent.ts → record_decision, PLAN_CONFIRM_THRESHOLD",
  },

  // --- Memory --------------------------------------------------------------
  {
    id: "session-scope",
    plane: "memory",
    label: "Nothing kept in the runtime",
    group: MEMORY_SHORT_TERM,
    brief: "Each turn gets its own session, deleted when it ends.",
    description:
      "Every turn creates its own runtime session and deletes it afterwards, so the model keeps nothing between turns and nothing of one user's project sits on a shared server. Everything that makes the conversation continuous is below, in our own database — which is what stops a turn depending on runtime state that could expire mid-thought.",
    enforcement: "control-loop",
    source: "project-agent.ts → sessionId per turn, finally deleteSession",
  },
  {
    id: "no-retrieval",
    plane: "memory",
    group: MEMORY_SHORT_TERM,
    label: "No semantic cache",
    brief: "The runtime's shared embedding cache is off for our sessions.",
    description:
      "The runtime can embed content into a vector cache and pull relevant pieces back into a later turn. That cache belongs to the process, not to the session, and one process serves every user here — separate Copilot licences do not give separate caches, because who pays for the inference says nothing about where the cache lives. So it is switched off. Belt and braces rather than load-bearing, and worth saying so: we hand the runtime no checkout, so there is almost nothing indexed to retrieve. It costs one line and closes the door.",
    enforcement: "provider-config",
    source: "project-agent.ts → skipEmbeddingRetrieval: true",
  },
  {
    id: "transcript",
    plane: "memory",
    label: "Project conversation",
    group: MEMORY_LONG_TERM,
    brief: "Replayed newest-first, as far as the budget you set reaches.",
    description: `This project's own chat, kept in our database and replayed newest-first into every turn, ~${Math.round(AGENT_HISTORY_BUDGET_CHARS / 1000)}k characters by default. A budget in characters rather than a message count, because eight short answers and eight long ones are not the same amount of context. It is per project: another project's conversation is never replayed here. This is the whole of the agent's long-term memory, and it is deliberately simple — there is no semantic search over your history and no summary. It works because the project itself is re-read from the repository every turn: the agent does not need to remember what it built, it can see it, so what this carries is only what was said. Filling backwards means the budget bites in the right place, dropping the oldest exchanges — worth knowing, because a decision argued out early in a long project is what falls off first, and raising the budget is how you keep it.`,
    enforcement: "control-loop",
    setting: "historyBudgetChars",
    source: "chat/route.ts → HISTORY_QUERY, recallConversation",
  },

  // --- Observability -------------------------------------------------------
  {
    id: "steps",
    plane: "observability",
    label: "Step trail",
    brief: "Thoughts, operations and MCP calls, as far as you let it record.",
    description:
      "The reasoning summaries, operations and MCP calls of a turn, written while it runs so a long turn shows progress, then stored with the reply. An MCP call is recorded with its server, its tool, and whether that server declared the tool read-only. A cap on the *record*, not on the turn — worth being exact about, because it is the one number here that does not restrain the agent: past it the entry is dropped and the turn carries straight on. What ends a turn is the operation budget, the timeout, or the model finishing. Set it against your operation budget: a turn allowed a hundred operations needs room for a hundred entries plus the lookups and narration around them, and a trail too small for its budget truncates a turn you can then no longer read back. About a quarter of it may be reasoning summaries, derived from this number rather than set beside it so a narrating turn can never crowd out the record of what it committed. If the trail is ever cut, its last entry says so.",
    enforcement: "recorded",
    setting: "maxSteps",
    source: "project-agent.ts → pushStep, Project.agentSteps",
  },
  {
    id: "history",
    plane: "observability",
    label: "Decision log",
    brief:
      "What was decided and why, with the edits it produced, on the Log tab.",
    description:
      "Every applied change with the commit it produced, grouped under the decision it implements, on the project's Log tab. The agent records what it was deciding, the requirements it read, what it chose and what it ruled out — so the project can still answer why it looks the way it does long after the conversation has scrolled away. A recorded decision is the agent's account rather than a fact, which is why the requirements it worked from are a field of their own and not buried in prose. Your canvas edits appear the same way minus the decision, because nobody recorded a reason for a drag and drop.",
    enforcement: "recorded",
    source: "ProjectDecision, ProjectOperation, log-panel.tsx",
  },
  {
    id: "decisions-in-force",
    plane: "memory",
    group: MEMORY_LONG_TERM,
    label: "Decisions in force",
    brief:
      "Earlier decisions travel into every turn, with what they ruled out.",
    description:
      "The decisions a project still stands by are put in front of the agent on every turn: the question, the choice, the reason and the options that lost. Structured memory rather than remembered conversation, and that is the point — the transcript is replayed newest-first into a character budget, so an answer settled twenty turns ago falls out of the window and gets proposed again. A few lines of decisions outlast it, and a decision that is now wrong is meant to be superseded out loud rather than quietly worked around.",
    enforcement: "recorded",
    source:
      "chat/route.ts → activeDecisions, project-agent.ts → decisionsInForce",
  },
];

/**
 * A turn as it actually runs, which the plane hierarchy cannot show.
 *
 * The harness diagram is a tree: which parts exist, and which of them a setting
 * belongs to. That is the right shape for "where do I change this" and the wrong
 * shape for "what happens, in what order, and what repeats" — so the Agent Loop
 * ended up drawn as one box among seven, which is exactly what a loop is not.
 * These three lists are the other question, and the loop diagram is built from
 * them so the two pictures cannot drift.
 *
 * Why it matters beyond looking right: the guardrail step runs on *every* pass. A
 * reader who sees Guardrails as a box beside Context has no way to tell whether it
 * happens once or forty times, and the answer is the whole reason it is worth
 * anything. Anything we add later that has to hold repeatedly — another check,
 * another budget — belongs on that step, and the drawing will say so.
 *
 * `actor` is who runs the step, and it is the honest part: the iteration is the
 * runtime's. `sendAndWait` is a single call and the loop turns inside it. We own
 * what goes in, the handlers it calls on the way round, and the limits that end it.
 */
export interface TurnStep {
  id: string;
  label: string;
  /** Whose code runs: ours, the model, or the runtime carrying it between them. */
  actor: "ours" | "model" | "runtime";
  detail: string;
  /** The plane whose settings govern this step, when one does. */
  plane?: HarnessPlane;
}

export const TURN_ACTORS: Record<TurnStep["actor"], string> = {
  ours: "TerraBlox",
  model: "Model",
  runtime: "Runtime",
};

/** Once, before the first pass. */
export const TURN_BEFORE: readonly TurnStep[] = [
  {
    id: "assemble",
    label: "Context assembled",
    actor: "ours",
    detail:
      "The project read from the branch, the module library, the ports, your instructions and as much of this project's conversation as the budget allows — built into one prompt.",
    plane: "context",
  },
  {
    id: "session",
    label: "Session created",
    actor: "ours",
    detail:
      "Model, thinking effort, the tool namespaces and the timeout are fixed here and hold for the whole turn. Nothing below can change them mid-turn.",
    plane: "model",
  },
];

/** Repeated until something ends the turn. */
export const TURN_LOOP: readonly TurnStep[] = [
  {
    id: "read",
    label: "The model reads",
    actor: "model",
    detail:
      "Everything assembled above, plus every tool result appended so far this turn. It does not see the repository — only what was put in front of it.",
    plane: "context",
  },
  {
    id: "decide",
    label: "It calls a tool, or answers",
    actor: "model",
    detail:
      "Only tools registered on the session can be named. An answer instead of a call is what ends the loop normally.",
    plane: "tools",
  },
  {
    id: "check",
    label: "We check the call",
    actor: "ours",
    detail:
      "Our handler runs before anything happens: arguments and ports validated against the project as the queue will leave it, an edit queued rather than applied, an MCP call counted and recorded. A refusal is handed back as the result, so the model can correct itself on the next pass. This is the step that repeats — every guardrail we have sits here.",
    plane: "guardrails",
  },
  {
    id: "append",
    label: "The result goes back",
    actor: "runtime",
    detail:
      "The result or the refusal is appended to the conversation and the call is charged to the turn's budget. Then the model reads again.",
    plane: "loop",
  },
];

/** How a turn stops, in the order of how happily. */
export const TURN_EXITS: readonly {
  id: string;
  label: string;
  detail: string;
  plane?: HarnessPlane;
}[] = [
  {
    id: "answered",
    label: "The model answers",
    detail:
      "The ordinary way out: it has done what it set out to do and says so.",
  },
  {
    id: "budget",
    label: "A budget is spent",
    detail:
      "The call past the limit is refused with a reason, so the model reports what it has already queued instead of looping. Whatever it queued still commits.",
    plane: "loop",
  },
  {
    id: "expired",
    label: "The timeout fires",
    detail:
      "The request is aborted and the session deleted, so work in flight stops rather than continuing unwatched. Nothing is committed — the repository is left as it was.",
    plane: "loop",
  },
];

/** Once, after the last pass. */
export const TURN_AFTER: readonly TurnStep[] = [
  {
    id: "apply",
    label: "The queue is applied",
    actor: "ours",
    detail:
      "Each queued edit is applied as the same mutation a manual canvas edit makes, then committed once. This is the only point in the turn where anything reaches your repository.",
    plane: "guardrails",
  },
  {
    id: "store",
    label: "The trail is stored",
    actor: "ours",
    detail:
      "The reasoning summaries, the operations and the MCP calls are saved with the reply, and each applied change appears in the project's history with its commit.",
    plane: "observability",
  },
];

export function elementsOnPlane(plane: HarnessPlane): HarnessElement[] {
  return HARNESS_ELEMENTS.filter((element) => element.plane === plane);
}

/**
 * A plane's elements, in their groups, in the order both surfaces render them.
 *
 * Returns a single unnamed group when the plane has no divisions, so a caller can
 * render every plane the same way instead of branching on whether Memory is the
 * one being drawn.
 */
export function groupedElementsOnPlane(
  plane: HarnessPlane,
): Array<{ group: string | null; elements: HarnessElement[] }> {
  const groups: Array<{ group: string | null; elements: HarnessElement[] }> =
    [];

  for (const element of elementsOnPlane(plane)) {
    const key = element.group ?? null;
    // Matched anywhere rather than only against the last group. Grouping only
    // consecutive elements meant an entry filed away from its neighbours printed
    // its heading a second time, which read as two different groups with the same
    // name. Array order still decides the order — of the groups by first
    // appearance, and of the elements inside each — so it remains the layout.
    const existing = groups.find((entry) => entry.group === key);

    if (existing) existing.elements.push(element);
    else groups.push({ group: key, elements: [element] });
  }

  return groups;
}
