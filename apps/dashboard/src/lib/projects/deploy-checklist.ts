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
  /** Only where it says something the label does not. */
  detail?: string | null;
  /** True for machine text, such as CloudFormation's own status. */
  mono?: boolean;
  /**
   * Where to go and look at what this line created.
   *
   * Only worth offering once the line is done — a link to a stack that is still
   * being built shows a page that contradicts the spinner beside it, and one to a
   * stack that failed and was deleted again is a 404 dressed up as an answer.
   */
  link?: { href: string; label: string } | null;
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
  reusedOidcProvider: boolean;
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
}): ChecklistItem[] {
  const { stack } = input;

  const stackState: ChecklistState =
    stack === null
      ? input.failure !== null
        ? "failed"
        : input.busy === "role"
          ? "active"
          : "pending"
      : stack.succeeded
        ? "done"
        : stack.settled
          ? "failed"
          : "active";

  /** Both are one call, so neither can be further along than the other. */
  const saveState: ChecklistState =
    input.busy === "role-variables"
      ? "active"
      : input.saveFailed
        ? "failed"
        : "pending";

  return [
    {
      id: "stack",
      label: "Create the role and its trust for GitHub",
      // CloudFormation's own word, but only while the stack is still moving.
      // `DELETE_IN_PROGRESS` is why: "Working on it" alone would hide that the
      // stack is undoing itself. Once it has succeeded the raw status says nothing
      // the tick does not, so it goes — which is what `CREATE_COMPLETE` sitting
      // under a finished step was doing.
      detail:
        stackState === "active" && stack !== null
          ? stack.status
          : stackState === "done" && input.reusedOidcProvider
            ? "Reused the GitHub identity provider this account already had."
            : stack === null
              ? (input.driftNote ?? null)
              : null,
      // Named for what it opens rather than "View in AWS": the reader is being
      // told which of the two stacks this is as much as where the link goes.
      link:
        stackState === "done"
          ? (() => {
              const href = cloudFormationConsoleUrl(stack?.stackId);
              return href ? { href, label: "Open the stack in AWS" } : null;
            })()
          : null,
      mono: stackState === "active" && stack !== null,
      state: stackState,
    },
    {
      id: "record",
      label: "Record the role on this project",
      state: input.roleReady ? "done" : saveState,
    },
    {
      id: "variables",
      label: "Write the role into the repository's Actions variables",
      // The one failure that leaves the rest of the step working: the workflows
      // fall back to the values rendered into them, so this degrades rather than
      // breaks, and the line has to say so instead of only going red.
      detail: input.variablesReady ? null : input.variablesError,
      state: input.variablesReady
        ? "done"
        : input.variablesError !== null
          ? "failed"
          : saveState,
    },
  ];
}
