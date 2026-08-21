/**
 * The runtime choices a turn can be given, in a module the browser can import.
 *
 * Separate from `settings-service` because that file is `server-only` — it holds
 * the Prisma client and the secret box. The lists themselves are just constants,
 * and both the settings screen and the chat composer need them to render a
 * dropdown. Before this they were copied by hand into the composer, which is one
 * copy too many for a list that decides what the server will accept.
 */

/** The levels the Copilot SDK defines. Which of them a model accepts varies. */
export const REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningEffortValue = (typeof REASONING_EFFORTS)[number];

/**
 * What a null `turnTimeout` means, in seconds.
 *
 * Five minutes is generous for most prompts. `project-agent.ts` derives its
 * millisecond constant from this so that "no choice" and "five minutes" cannot
 * drift apart.
 */
export const DEFAULT_TURN_TIMEOUT_SECONDS = 300;

/**
 * Bounds on a turn timeout.
 *
 * The floor exists because a turn that cannot finish is worse than no limit: the
 * agent would be killed mid-tool-call every time and the user would only ever see
 * a timeout. The ceiling is what stops a stuck turn from holding a session open
 * for the rest of the day.
 */
export const TURN_TIMEOUT_MIN_SECONDS = 30;
export const TURN_TIMEOUT_MAX_SECONDS = 1800;

/**
 * The timeouts offered in the settings dropdown.
 *
 * A fixed list rather than a free number field: every value in range is accepted
 * by the API, but a picker cannot be typed wrong, needs no error state, and the
 * labels say what the number means without arithmetic.
 */
export const TURN_TIMEOUT_CHOICES: ReadonlyArray<{
  seconds: number;
  label: string;
}> = [
  { seconds: 60, label: "1 minute" },
  { seconds: 120, label: "2 minutes" },
  { seconds: 300, label: "5 minutes" },
  { seconds: 600, label: "10 minutes" },
  { seconds: 900, label: "15 minutes" },
  { seconds: 1800, label: "30 minutes" },
];

/**
 * Models offered when the runtime cannot be asked.
 *
 * The listing needs the user's Copilot entitlement, and that request can fail —
 * no seat, a network problem, a runtime that will not start. Without a fallback
 * the dropdown would then be empty, which reads as "there are no models" rather
 * than "we could not check".
 *
 * Ids verified against a real `models.list` response rather than guessed; a
 * wrong id is only discovered when a turn is rejected.
 */
export const FALLBACK_MODELS: ReadonlyArray<{
  id: string;
  name: string;
  reasoningEfforts: string[];
  multiplier: number | null;
}> = [
  {
    id: "claude-opus-5",
    name: "Claude Opus 5",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    multiplier: null,
  },
  {
    id: "claude-opus-4.8",
    name: "Claude Opus 4.8",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    multiplier: null,
  },
];

/**
 * How many entries of a turn we are willing to record and replay.
 *
 * A cap on the *record*, and nothing more — worth stating plainly, because it used
 * to be presented as a limit on the agent. Overflow drops the step entry; the turn
 * carries on. What stops a turn is {@link AGENT_MAX_TOOL_CALLS}.
 *
 * Not a setting: raising it would only let a user make their own transcript
 * unreadable. Exported so the settings screen can state the real number.
 */
export const AGENT_MAX_STEPS = 40;

/**
 * How many operations one turn may queue.
 *
 * This is the real budget: the call past the limit is refused, with a reason the
 * model can report, so a turn that has started looping ends by answering rather
 * than by timing out. It sits above any plausible single request — building a
 * small stack from nothing is a handful of modules and their wiring — so hitting
 * it is a signal that something went wrong, not that the user asked for a lot.
 *
 * Not a setting either, and for a sharper reason than the record cap: every queued
 * operation becomes a commit in the user's repository after the turn. A budget a
 * user could raise is a budget an agent having a bad day can spend.
 */
export const AGENT_MAX_TOOL_CALLS = 25;

/**
 * The sentences that tell the agent how to work, before any project detail.
 *
 * Here rather than in the prompt builder because they are editable in the admin
 * panel, and the store that merges the overrides must not pull the agent — and
 * with it the Copilot SDK — into a browser bundle.
 *
 * `{maxToolCalls}` is a placeholder rather than a written-out number, so an edited
 * rule cannot end up quoting a budget the code does not enforce. It is the one
 * part of this text that is a fact rather than a preference.
 */
export const DEFAULT_OPERATING_RULES: readonly string[] = [
  "You edit Terraform root configurations only through the tools you were given. Never invent HCL in your reply as a substitute for calling a tool.",
  "Every tool call is committed to the repository after your turn, and you may queue at most {maxToolCalls} of them. Say what you changed.",
  // The single most load-bearing sentence here. Nothing the agent does is visible
  // to it until the turn ends, so without this it answers from memory of its own
  // calls and reports work it never finished.
  "Your edits are queued, not applied, while you work. `review_project` is the only way to see what they add up to: call it after changing anything, and fix what it reports before you answer.",
  "Look a module up with `describe_module` before wiring it. An input or output name you guessed is written exactly as you gave it, and only fails when somebody runs Terraform.",
  "For anything larger than a single edit, state the plan with `propose_plan` before building. If it adds more than a handful of modules, present it and let the user confirm rather than building it in the same turn.",
  "Cost is a design decision, not an afterthought. When a module you place has resources that bill for merely existing, say so and name the input that decides how many there are.",
  "Keep replies short and concrete. Say what you changed, not how the tools work.",
];

/** Substitutes the facts an edited rule must not be able to misstate. */
export function renderOperatingRule(rule: string): string {
  return rule.replace("{maxToolCalls}", String(AGENT_MAX_TOOL_CALLS));
}

/**
 * How much of a project's conversation is replayed into a turn, in characters.
 *
 * A budget rather than a message count. Counting messages was arbitrary in both
 * directions: eight one-line answers is nothing, and eight long ones is more than
 * a fixed number implies. Filling backwards from the newest message until the
 * budget runs out means an ordinary project has its whole conversation in the
 * prompt, and only a very long one starts forgetting its oldest turns.
 *
 * It cannot be unbounded. The transcript grows for as long as the project lives,
 * and a prompt that grows with it eventually exceeds the model's context window —
 * the failure would arrive as a broken turn on the day someone was busiest.
 *
 * ~24k characters is roughly six thousand tokens: dozens of turns, and small
 * next to the graph and the module library that travel with it.
 */
export const AGENT_HISTORY_BUDGET_CHARS = 24_000;

/**
 * How often the running turn's progress is written to the database, in ms.
 *
 * A reasoning model emits summaries in bursts, and every tool call adds another
 * step, so writing each one would put dozens of round trips in the middle of the
 * turn it is meant to be reporting on. Two seconds is below the poll interval
 * that reads it, which is all the resolution the UI can display anyway.
 */
export const AGENT_PROGRESS_INTERVAL_MS = 2_000;

/**
 * How many times one turn may read from the linked application repository.
 *
 * Reads do not commit anything, so they are not on {@link AGENT_MAX_TOOL_CALLS} —
 * spending that budget on looking would mean a turn that studied an application
 * carefully had nothing left to build with. They still need a ceiling of their
 * own: each read is a GitHub request on the user's rate limit, and a model that
 * has decided to read a whole monorepo has stopped making progress.
 *
 * Generous on purpose. Understanding an unfamiliar application is a dozen files
 * — a manifest, a Dockerfile, a compose file, some configuration — and the limit
 * should only bite when something has gone wrong.
 */
export const AGENT_MAX_APP_REPO_READS = 40;

/**
 * How many paths one `list_app_files` call may return.
 *
 * A monorepo tree is tens of thousands of entries, which would fill the model's
 * context with paths and leave no room to reason about them. The cap is paired
 * with the tool's `path` argument: the answer to a truncated listing is to look
 * at one subtree, not to raise the limit.
 */
export const AGENT_APP_REPO_TREE_LIMIT = 400;

/**
 * How much of one application file is handed to the model, in characters.
 *
 * A lock file or a bundled asset is megabytes, and reading one would cost the
 * turn its context for no information. Anything that states what an application
 * needs — a manifest, a Dockerfile, a compose file — is far below this, so the
 * truncation only ever hits files whose tail was not going to help.
 */
export const AGENT_APP_REPO_FILE_CHARS = 20_000;

/**
 * Directories never listed from an application repository.
 *
 * Dependencies and build output, which are the bulk of the entries in a real
 * repository and say nothing about the application that its manifests do not say
 * better. Excluding them is what makes {@link AGENT_APP_REPO_TREE_LIMIT} enough
 * for an ordinary project rather than a limit hit on the first call.
 */
export const AGENT_APP_REPO_IGNORED_DIRS: ReadonlyArray<string> = [
  ".git",
  ".gradle",
  ".idea",
  ".mypy_cache",
  ".next",
  ".nuxt",
  ".pytest_cache",
  ".terraform",
  ".venv",
  ".yarn",
  "__pycache__",
  "bower_components",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor",
  "venv",
];
