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
 * Thirty minutes, which is also the ceiling: the default is the most generous
 * setting and the dial only turns down. That is the right way round for a limit
 * whose job is to stop a *stuck* turn rather than to ration a working one — a turn
 * killed while it was still making progress produces nothing at all, no commit and
 * no explanation, which is a worse outcome than one that ran long.
 *
 * `project-agent.ts` derives its millisecond constant from this so that "no
 * choice" and the number cannot drift apart.
 */
export const DEFAULT_TURN_TIMEOUT_SECONDS = 1800;

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

/*
 * The lists of offered values that used to sit here are gone, along with the three
 * others like them. They existed so a dial could not be typed wrong, which held —
 * but every value in range was accepted by the API regardless, so each list was a
 * guess at which numbers anyone would want, and any value reached by another route
 * had to be spliced back in to stop the dropdown showing something other than what
 * the turn enforced. Six such settings now exist; the fields validate against these
 * bounds instead.
 */

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
 * How many entries of a turn we are willing to record, by default.
 *
 * A cap on the *record*, and nothing more — worth stating plainly, because it is
 * routinely read as a limit on the agent. Overflow drops the entry; the turn
 * carries on. Nothing here bounds the model's loop either: that runs inside the
 * runtime's `sendAndWait`, and what ends a turn is the operation budget refusing a
 * call, the turn timeout, or the model deciding it is done.
 *
 * Was 40, which was far below what one turn legitimately produces and therefore
 * lost the very thing the record exists for. A turn that built a ten-module stack
 * spent its whole hundred-operation budget, and the trail held the first ten
 * lookups, ten additions and two edits before it stopped — so eighty of the
 * hundred operations, and with them the reason the turn ran out, appeared nowhere.
 * Reading it back, the turn looked like it had done a quarter of the work.
 *
 * 500 sits above what the real budgets allow: a hundred operations, a hundred MCP
 * calls and forty repository reads come to 240 entries, and the lookups and
 * reasoning summaries around them fit in what is left.
 *
 * A setting, after all. The earlier argument against one was that every other dial
 * bounds something that costs the user a commit, a request or a token, while this
 * bounds a JSON column — so turning it down buys nothing. True, but it only
 * covered turning it *down*. The row is read back by every client that loads the
 * transcript, and someone running long turns against a raised operation budget has
 * a real reason to want more of it than we guessed, while someone on a slow
 * connection has a real reason to want less. Both are answers about their own
 * transcript, which is theirs to give.
 */
export const AGENT_MAX_STEPS = 500;

/**
 * Bounds on the recorded trail.
 *
 * The floor is where the record still explains a turn: below about fifty entries a
 * turn spending even a modest budget would be truncated, which is the failure this
 * limit was raised from 40 to avoid in the first place. The ceiling is what keeps a
 * looping turn from writing an unbounded row — the reason the cap exists at all,
 * and the one part of it that is not the user's call.
 */
export const STEP_TRAIL_MIN = 50;
export const STEP_TRAIL_MAX = 2_000;

/**
 * How many of those entries may be reasoning summaries.
 *
 * The trail carries two different things. A tool entry is the audit record of a
 * change that reached the repository; a thought is the model narrating. Only the
 * first has to survive, so only the second gets a cap of its own — otherwise a
 * chatty turn could spend the whole record on commentary and leave the reader
 * unable to see what was committed.
 *
 * Derived from the trail size rather than set beside it, which is what stops the
 * pair from ever contradicting each other. A second dial would let someone allow
 * 300 thoughts in a 100-entry trail: accepted by every validator, meaningless in
 * effect, and impossible to explain on the screen that offered it. The proportion
 * reproduces today's 120-in-500 exactly, so raising the trail buys proportionally
 * more narration and the same guarantee that operations cannot be crowded out.
 */
export function maxThoughtsFor(maxSteps: number): number {
  return Math.max(10, Math.round(maxSteps * 0.24));
}

/**
 * How many operations one turn may queue.
 *
 * The real budget: the call past the limit is refused, with a reason the model can
 * report, so a turn that has started looping ends by answering rather than by
 * timing out.
 *
 * The default is the ceiling, so this dial only turns down. Deliberate — the
 * budget exists to convert a loop into a report, not to ration a turn that is
 * working, and a request like "build me a stack" legitimately spends dozens of
 * operations. What makes lowering it meaningful is the other end: every queued
 * operation becomes a commit after the turn, so the number is the size of the
 * largest change one unreviewed turn can make. Set to 1, the agent stops and
 * reports after every single edit.
 */
export const AGENT_MAX_TOOL_CALLS = 100;

export const TOOL_CALL_BUDGET_MIN = 1;
export const TOOL_CALL_BUDGET_MAX = 100;

/**
 * How many MCP tool calls one turn may make.
 *
 * Counted apart from {@link AGENT_MAX_TOOL_CALLS} because the two are different
 * risks. An operation ends up as a commit in the user's repository, so its budget
 * is about what one unreviewed turn may change. An MCP call changes nothing here:
 * it is a request to a server the user connected, made on whatever credential they
 * stored with it. Sharing one budget would mean a turn that read a vendor's
 * documentation properly had nothing left to build with — the same mistake the
 * application-repository reads already have their own ceiling to avoid.
 *
 * It still needs a ceiling rather than none: the request leaves our network, and
 * without a limit a model stuck on a search can only run into the turn timeout,
 * which reaches the user as a hang rather than as an answer. The default is that
 * ceiling, so the dial turns down for anyone who wants a tighter leash on an
 * outside server and never up into an unbounded loop.
 */
export const AGENT_MAX_MCP_CALLS = 100;

export const MCP_CALL_BUDGET_MIN = 1;
export const MCP_CALL_BUDGET_MAX = 100;

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
  "For anything larger than a single edit, record what you decided and why with `record_decision` before building. Everything you queue after it is filed under it, so the project's log can explain itself later. If it adds more than a handful of modules, present it and let the user confirm rather than building it in the same turn.",
  "Cost is a design decision, not an afterthought. When a module you place has resources that bill for merely existing, say so and name the input that decides how many there are.",
  "Keep replies short and concrete. Say what you changed, not how the tools work.",
  // Last, because it is about how everything above is written rather than about
  // what to do. The reasoning summaries already arrive in English whatever the
  // conversation is in; this is what stops the durable half — decisions, plans,
  // replies — from following the prompt into a second language.
  "Write in English: decisions, plans, summaries and your replies, whatever language the user writes in. Their own words stay as they wrote them, and quoting them is fine. Everything you record becomes this project's documentation, and documentation in two languages cannot be read by the next person or searched by anyone.",
];

/**
 * Substitutes the facts an edited rule must not be able to misstate.
 *
 * The budget is passed in rather than read from the constant, because it is a
 * setting now: a rule telling the agent it may queue 25 changes, sent to a user
 * who lowered the budget to 5, would be the prompt lying about what the code will
 * allow. Omitted falls back to the default, which is right for the admin preview —
 * that screen edits the rules for everyone and belongs to no one user.
 */
export function renderOperatingRule(
  rule: string,
  maxToolCalls: number = AGENT_MAX_TOOL_CALLS,
): string {
  return rule.replace("{maxToolCalls}", String(maxToolCalls));
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
 *
 * The default rather than a law. How much of its own history a project needs is a
 * property of the project: a long-running one where decisions were argued out in
 * chat wants more, a scratch one wants none of it in the way.
 */
export const AGENT_HISTORY_BUDGET_CHARS = 24_000;

/**
 * Bounds on the replayed conversation, in characters.
 *
 * The floor keeps the newest exchange whole — below a couple of thousand
 * characters the agent would lose the answer it just gave, which reads as amnesia
 * rather than as a budget. The ceiling exists because the transcript shares the
 * model's context window with the graph, the module library and the ports: a
 * budget large enough to crowd those out would trade the project the agent is
 * editing for the conversation about it.
 */
export const HISTORY_BUDGET_MIN_CHARS = 2_000;
export const HISTORY_BUDGET_MAX_CHARS = 120_000;

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
 * Bounds on the reading budget.
 *
 * The floor is one, which is a coherent choice rather than a broken one: it lets a
 * turn look at a single named file — a manifest — and no further. The ceiling is
 * well above what understanding an application takes, because what it guards
 * against is not a thorough turn but a model that has decided to read a monorepo,
 * spending somebody's GitHub rate limit on it.
 */
export const APP_REPO_READS_MIN = 1;
export const APP_REPO_READS_MAX = 200;

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
 * Bounds on one listing.
 *
 * Raising it is the honest answer for a genuinely large repository, where the
 * intended one — narrow the `path` — needs a first listing broad enough to see
 * which subtree to narrow to. The ceiling is where the paths would start crowding
 * out the reasoning about them, which costs the turn the context it was spending
 * the listing to get.
 */
export const APP_REPO_TREE_MIN = 50;
export const APP_REPO_TREE_MAX = 2_000;

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
 * Bounds on one file.
 *
 * The floor still holds a manifest or a Dockerfile whole, which is the case this
 * operation exists for. The ceiling shares its reasoning with the conversation
 * budget: the file competes for the same context window as the graph and the
 * module library, so a limit large enough to swallow a lock file would trade the
 * project being edited for one file about it.
 */
export const APP_REPO_FILE_CHARS_MIN = 2_000;
export const APP_REPO_FILE_CHARS_MAX = 200_000;

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
