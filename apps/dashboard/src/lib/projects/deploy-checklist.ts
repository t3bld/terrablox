/**
 * What a wizard step is going to do, and how far it has got.
 *
 * Separate from the component because it is the part with the decisions in it, and
 * because a derivation with four states across three lines is worth being able to
 * check without a browser. The component renders whatever this returns.
 */

/** The bit of a CloudFormation stack a checklist needs. Structural on purpose. */
export interface ChecklistStack {
  status: string;
  settled: boolean;
  succeeded: boolean;
  /** The stack ARN, for the console link. Null before the stack exists. */
  stackId?: string | null;
}

/**
 * A deep link to the stack in the CloudFormation console.
 *
 * Built from the ARN rather than from the project's region setting, because the
 * ARN says where the stack actually is: `arn:aws:cloudformation:eu-central-1:…`.
 * Someone who changes the region afterwards would otherwise get a link to an empty
 * console in the new region rather than to the stack they just created.
 *
 * Returns null rather than a guess when the ARN is not the shape we expect. A dead
 * link into someone's AWS account is worse than no link: it reads as "the stack is
 * not there".
 */
export function cloudFormationConsoleUrl(
  stackId: string | null | undefined,
): string | null {
  if (!stackId) return null;

  const region = stackId.split(":")[3];
  if (!region) return null;

  // The console lives on a different domain in the partitions that are their own
  // deployment of AWS. Cheap to get right here, and a link to `.com` simply does
  // not resolve for anyone in either of them.
  const host = region.startsWith("cn-")
    ? "console.amazonaws.cn"
    : region.startsWith("us-gov-")
      ? "console.amazonaws-us-gov.com"
      : "console.aws.amazon.com";

  return `https://${region}.${host}/cloudformation/home?region=${region}#/stacks/stackinfo?stackId=${encodeURIComponent(stackId)}`;
}

/** Where one line of a checklist has got to. */
export type ChecklistState = "pending" | "active" | "done" | "failed";

export interface ChecklistItem {
  id: string;
  label: string;
  state: ChecklistState;
  /**
   * Only where it says something the label does not.
   *
   * Not for progress. CloudFormation's own status used to appear here while a
   * stack was building, which meant the list narrated `CREATE_IN_PROGRESS` at a
   * reader who could already see the spinner. What belongs here is a fact that
   * outlives the step: what was reused, what is missing, what failed.
   */
  detail?: string | null;
  /**
   * Where to go and look at what this line created.
   *
   * Withheld while a line is still working: a link to a stack mid-build shows a
   * page that contradicts the spinner beside it, and one to a stack that failed
   * and rolled itself back is a 404 dressed up as an answer.
   */
  link?: { href: string; label: string } | null;
}

/**
 * The repository's Actions variables, on GitHub.
 *
 * Environment variables and secrets each have their own tab under the same
 * settings page, so the path has to be the specific one or the reader lands on a
 * screen that does not contain what they came to check.
 */
export function actionsVariablesUrl(
  repoFullName: string | null,
): string | null {
  return repoFullName
    ? `https://github.com/${repoFullName}/settings/variables/actions`
    : null;
}

/**
 * What the role step is going to do, and how far it has got.
 *
 * Three lines because the step is three writes to three different places — the
 * customer's AWS account, this project, and the repository — and which of them has
 * happened is exactly what someone asks when it stops halfway.
 *
 * A pure function of what has been read back, rather than a state machine that
 * advances itself. Nothing here is on a timer or moved optimistically: a tick means
 * CloudFormation reported the stack, or `state.setup` re-derived the other two from
 * the project and the repository. That is what makes the list safe to show before
 * anything has run — the grey lines are not a promise, they are the same three
 * facts read as false.
 */
/**
 * How far the "create it in AWS" line has got.
 *
 * Shared by both steps because both are the same question asked of CloudFormation.
 * A stack that is absent is not automatically "not started": a create made with
 * `OnFailure: DELETE` removes its own evidence, so the failure it left behind is
 * what distinguishes "never ran" from "ran and was rolled back".
 */
function stackLineState(
  stack: ChecklistStack | null,
  failure: string | null,
  running: boolean,
): ChecklistState {
  if (stack === null) {
    if (failure !== null) return "failed";
    return running ? "active" : "pending";
  }
  if (stack.succeeded) return "done";
  return stack.settled ? "failed" : "active";
}

/** How far the writes after the stack have got, when neither is done yet. */
function saveLineState(running: boolean, failed: boolean): ChecklistState {
  if (running) return "active";
  return failed ? "failed" : "pending";
}

export function buildRoleChecklist(input: {
  stack: ChecklistStack | null;
  /** What a rolled-back stack said on its way out, once it is gone. */
  failure: string | null;
  /** The in-flight key, so the two phases can show their own spinner. */
  busy: "role" | "role-variables" | string | null;
  roleReady: boolean;
  variablesReady: boolean;
  saveFailed: boolean;
  variablesError: string | null;
  /**
   * The state of the identity provider the role's trust policy names.
   *
   * Three answers rather than two, because "there is one" and "it works" are
   * different facts and only the second matters. A provider registered for another
   * audience reports itself as present, which is how a perfectly formed role came to
   * be unassumable with nothing in the flow able to say why.
   *
   * Null is unknown: either the stack has not finished, so there is nothing to check
   * yet, or the session may not read IAM. Both show as unchecked rather than as
   * broken, because a false alarm here sends someone rebuilding a working role.
   */
  oidcProvider: "ready" | "missing" | "wrong-audience" | null;
  /** For the link to the variables on GitHub. Null while the project is loading. */
  repoFullName?: string | null;
  /**
   * Why the stack is missing, when the project believes it was created.
   *
   * Without it the list reads incoherently in exactly the case that matters: after
   * a region or account change, the first line is grey because no stack answers to
   * the name, while the two below it are green because the ARN is recorded and the
   * variables are written. All three are true. Saying why on the first line is what
   * turns "grey, green, green" from a contradiction into an explanation.
   */
  driftNote?: string | null;
  /**
   * What was already true when the current run started.
   *
   * These only ever add an explanation to a line that is already done; neither can
   * make a line look finished. Rebuilding a setup that is up to date changes nothing
   * after the stack itself, and without this the two ticks below it are
   * indistinguishable from work this run did.
   */
  recordUnchanged?: boolean;
  variablesUnchanged?: boolean;
}): ChecklistItem[] {
  const { stack } = input;

  const stackState = stackLineState(
    stack,
    input.failure,
    input.busy === "role",
  );

  /** Both are one call, so neither can be further along than the other. */
  const saveState = saveLineState(
    input.busy === "role-variables",
    input.saveFailed,
  );

  return [
    {
      id: "stack",
      label: "Create the role in AWS",
      // Only the drift note. Whether the identity provider was created here or
      // already existed does not change what this line reports — the stack ran and
      // the role is there either way — and the line below is the one that says
      // something about the provider worth knowing.
      detail: stack === null ? (input.driftNote ?? null) : null,
      // Named for what it opens rather than "View in AWS": the reader is being
      // told which of the two stacks this is as much as where the link goes.
      link:
        stackState === "done"
          ? (() => {
              const href = cloudFormationConsoleUrl(stack?.stackId);
              return href ? { href, label: "Open the stack in AWS" } : null;
            })()
          : null,
      state: stackState,
    },
    {
      // Its own line rather than a detail of the one above, because it is a
      // separate thing that can be true or false: the stack can have succeeded and
      // the trust still be dead. That combination is the one that used to reach the
      // user half an hour later as a workflow failing to assume the role.
      //
      // The provider is account-wide and shared by every project here, so it
      // belongs to whichever project's stack created it first. Deleting that stack
      // used to take the provider with it and break every other role in the
      // account, while nothing about those roles changed — they went on naming a
      // federated principal that was gone. The template now retains it, and this
      // line is how a provider that went missing before that becomes visible here
      // instead of in a workflow log.
      id: "oidc",
      label: "Trust GitHub's identity provider in this account",
      // Gated on the stack having finished, exactly like the state below it. The
      // detail was not, which let a "missing" answer print its explanation under a
      // grey line that had not been checked yet — a warning about a step that had
      // not run. Only the caller's habit of reporting nothing until then kept it off
      // the screen, and that is not a property this list should depend on.
      detail:
        stackState !== "done"
          ? null
          : input.oidcProvider === "missing"
            ? "Not in this account. It is shared by every project here, so deleting another project's role stack can take it with it. Run this step again to create it — nothing else needs redoing."
            : input.oidcProvider === "wrong-audience"
              ? "One is registered, but not for the audience the role asks for (sts.amazonaws.com), so no deploy can assume the role. Run this step again: the audience is added to the existing provider, which changes nothing else that uses it."
              : input.oidcProvider === null
                ? "Could not check: this session may not read identity providers."
                : null,
      // Only ever an answer once the stack has finished. Before that it is either
      // irrelevant or about to change, and a red line there would send someone
      // rebuilding a role that was never the problem.
      state:
        stackState !== "done"
          ? "pending"
          : input.oidcProvider === "ready"
            ? "done"
            : input.oidcProvider === null
              ? "pending"
              : "failed",
    },
    {
      id: "record",
      label: "Store the role in the database",
      detail:
        input.roleReady && input.recordUnchanged
          ? "Already stored, so this run left it alone."
          : null,
      state: input.roleReady ? "done" : saveState,
    },
    variablesLine({
      label: "Write the role to the repository's variables",
      ready: input.variablesReady,
      error: input.variablesError,
      fallback: saveState,
      repoFullName: input.repoFullName ?? null,
      unchanged: input.variablesUnchanged,
    }),
  ];
}

/**
 * The "write it into the repository" line, which both steps end with.
 *
 * One function because it is one write: the same call puts the role, the region and
 * the state bucket into the same three Actions variables, so a single flag reports
 * it and neither step can claim it succeeded while the other says it failed.
 */
function variablesLine(input: {
  label: string;
  ready: boolean;
  error: string | null;
  fallback: ChecklistState;
  repoFullName: string | null;
  /** True when this was already satisfied before the current run started. */
  unchanged?: boolean;
}): ChecklistItem {
  const state: ChecklistState = input.ready
    ? "done"
    : input.error !== null
      ? "failed"
      : input.fallback;

  const href = actionsVariablesUrl(input.repoFullName);

  return {
    id: "variables",
    label: input.label,
    // Two things this line can have to say, and which one depends on who is asking.
    //
    // The error, because it is the one failure that leaves the rest of the step
    // working: the workflows fall back to the values rendered into them, so this
    // degrades rather than breaks, and the line has to say so instead of only
    // going red.
    //
    // Otherwise, on a re-run, that there was nothing to do. A tick on a line that
    // was already ticked before the run started looks exactly like a line this run
    // completed, so a rebuild reads as having skipped its last two steps. It did
    // skip them, correctly — the value it would write is the value already there.
    // Saying that is the difference between "nothing happened" and "nothing needed
    // to happen".
    detail: input.ready
      ? input.unchanged
        ? "Already set to these values, so this run left them alone."
        : null
      : input.error,
    // Offered on failure as well, which the stack link above deliberately is not.
    // The difference is that this page exists either way: when writing the variables
    // is refused, going and setting them by hand is the actual remedy, so
    // withholding the link would hide the way out.
    link:
      (state === "done" || state === "failed") && href
        ? { href, label: "Open the variables on GitHub" }
        : null,
    state,
  };
}

/**
 * What the state step is going to do, and how far it has got.
 *
 * The same three writes as the role step, to the same three places — the customer's
 * AWS account, this project, and the repository. Deliberately the same shape: the
 * two steps were doing the same kind of work while looking nothing alike, one with
 * a checklist and one with a status line and a button asking the user to copy the
 * outputs across.
 */
export function buildStateChecklist(input: {
  stack: ChecklistStack | null;
  /** What a rolled-back stack said on its way out, once it is gone. */
  failure: string | null;
  busy: "state" | string | null;
  /** The bucket and the key are recorded on the project. */
  stateReady: boolean;
  variablesReady: boolean;
  saveFailed: boolean;
  variablesError: string | null;
  /** The bucket the stack created, once it is known. */
  bucket?: string | null;
  repoFullName?: string | null;
  /** Why the stack is missing, when the project believes it was created. */
  driftNote?: string | null;
  /** What was already true when the current run started. See the role builder. */
  recordUnchanged?: boolean;
  variablesUnchanged?: boolean;
}): ChecklistItem[] {
  const { stack } = input;

  const stackState = stackLineState(
    stack,
    input.failure,
    input.busy === "state",
  );

  // Gated on the stack being done, which the role step gets for free by having a
  // second busy key for its save. Here both phases run under `state`, so without
  // the gate all three lines spun together while only the first was happening —
  // and a list whose every line is active is a list that has stopped saying
  // anything.
  const saveState = saveLineState(
    input.busy === "state" && stackState === "done",
    input.saveFailed,
  );

  return [
    {
      id: "stack",
      label: "Create the state backend in AWS",
      detail: stack === null ? (input.driftNote ?? null) : null,
      link:
        stackState === "done"
          ? (() => {
              const href = cloudFormationConsoleUrl(stack?.stackId);
              return href ? { href, label: "Open the stack in AWS" } : null;
            })()
          : null,
      state: stackState,
    },
    {
      id: "record",
      label: "Store the bucket in the database",
      // The name is the point of this line: it is what the backend file will
      // contain, and the only thing here a person might need to recognise later. It
      // keeps its place ahead of the unchanged note, which is the less useful of the
      // two facts once you already know the step did nothing.
      detail: input.stateReady
        ? input.recordUnchanged
          ? `${input.bucket ?? "Already stored"} — unchanged by this run.`
          : (input.bucket ?? null)
        : null,
      state: input.stateReady ? "done" : saveState,
    },
    variablesLine({
      label: "Write the bucket to the repository's variables",
      ready: input.variablesReady,
      error: input.variablesError,
      fallback: saveState,
      repoFullName: input.repoFullName ?? null,
      unchanged: input.variablesUnchanged,
    }),
  ];
}
