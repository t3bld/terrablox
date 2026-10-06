/**
 * Which deployment step the wizard is on, and what each one may offer.
 *
 * The wizard's state machine, and the reason it is not in the component: every
 * sentence of it was a bug once. Disconnecting the account left the wizard open on
 * step three, offering a stack it could no longer reach. A lost session left the
 * role and state steps reporting themselves finished, with pressable buttons, because
 * the project still recorded them. One shared "busy" flag greyed out Delete on the
 * state step while the role was working, with nothing on screen to explain it.
 *
 * None of those are visible in a rendered wizard until someone reproduces the exact
 * sequence. All of them are one assertion here.
 *
 * Nothing is remembered as progress: every field returned here is derived from what the
 * account, the repository and the project report right now, which is what makes
 * deleting a workflow reopen the wizard instead of leaving a tab that lies.
 */

import type { DeploySetupState } from "./types";

export interface BootstrapStack {
  stackName: string;
  /** The stack ARN, which is what the console link is made from. */
  stackId: string | null;
  status: string;
  statusReason: string | null;
  settled: boolean;
  succeeded: boolean;
  outputs: Record<string, string>;
}

/**
 * A bootstrap this project points at but cannot reach from where it is now.
 *
 * Reported by the server rather than worked out here, because deciding it needs the
 * session's account id — which is the thing the browser is not told.
 */
export interface BootstrapDrift {
  stackName: string;
  region: string;
  accountId: string | null;
  pointsAt: string;
  pointsAtAccount: string | null;
  /** True when creating it again here would fail on a name already taken. */
  collides: boolean;
}

export type StepId = "account" | "role" | "state" | "pipeline";

/**
 * What is in flight, which is finer-grained than the step.
 *
 * The role step has two buttons, and one spinner for both would show the stack
 * being created while the thing actually running is the save.
 */
export type BusyKey = StepId | "role-variables";

/**
 * The one order that works. Module level, so it is stated once rather than
 * implied by where the JSX happens to sit.
 */
export const ORDER: StepId[] = ["account", "role", "state", "pipeline"];

/** The last step, named rather than indexed, so it cannot be `undefined`. */
export const FINAL_STEP: StepId = "pipeline";

/**
 * Whether the deploy tab shows the wizard or the finished configuration.
 *
 * Here rather than inline in the panel for the reason the rest of this module exists:
 * it is a three-term disjunction with a precedence that is not obvious, and the
 * non-obvious part was a bug. `reconfiguring` outranks a complete setup — which is
 * correct, it is what lets somebody with a working pipeline go back and change it — and
 * that meant pressing Finalize left the tab in the wizard. The setup was complete, every
 * step was ticked, and the flag that had opened the wizard was still set because nothing
 * on the finish path cleared it.
 *
 * So the precedence is deliberate and the caller owes it a matching clear: whoever sets
 * `reconfiguring` is responsible for unsetting it when the reconfiguration ends, whether
 * that is by finishing or by backing out.
 *
 * `configured === null` means the state has not been read yet. Neither view is right
 * then — the wizard would flash at somebody whose setup is finished — so it answers
 * false and the panel renders nothing until the first read lands.
 */
export function showDeployWizard(input: {
  /** `setup.complete`, or null before the first read. */
  configured: boolean | null;
  /** The user asked to change a finished setup. */
  reconfiguring: boolean;
  /** The account the project points at, or null if it points at none. */
  awsAccountId: string | null;
}): boolean {
  if (input.configured === null) return false;

  return (
    !input.configured || input.reconfiguring || input.awsAccountId === null
  );
}

/**
 * This stack is coming down right now.
 *
 * True for a deletion this tab started *and* for one started in the console, which
 * is why it reads the status rather than only our own flag: a stack removed from
 * the AWS side would otherwise go on showing a step describing it. `DELETE_COMPLETE`
 * is settled and therefore not this — by then it is gone, and the step is honest
 * again.
 */
export function isStackDeleting(
  stack: BootstrapStack | null,
  tracked: string | undefined,
): boolean {
  return (
    tracked !== undefined ||
    Boolean(stack && !stack.settled && stack.status.startsWith("DELETE"))
  );
}

/** What the wizard has read, and what the user has asked to look at. */
export interface DeployStepsInput {
  /**
   * The AWS connection, or null before the first read.
   *
   * Null and "not connected" have to stay apart: treating the unread state as a
   * lost connection would flash step one at everybody on arrival.
   */
  connection: { connected: boolean } | null;
  setup: DeploySetupState;
  /** The step the user picked, which the machine may still override. */
  chosen: StepId | null;
  busy: BusyKey | null;
  roleStack: BootstrapStack | null;
  stateStack: BootstrapStack | null;
  /** Stack names this tab has asked CloudFormation to delete, by step. */
  deleting: { role?: string; state?: string };
  /** What the last failed attempt said, when the stack erased its own evidence. */
  roleFailure: string | null;
  stateFailure: string | null;
}

export interface DeployStepsView {
  done: Record<StepId, boolean>;
  current: StepId;
  /** Position of `current` in {@link ORDER}, for the Back and Continue buttons. */
  index: number;
  /** Where the work stands, regardless of what is being looked at. */
  nextUnfinished: StepId;
  awsLost: boolean;
  hadProgress: boolean;
  roleBusy: boolean;
  stateBusy: boolean;
  /** Anything at all in flight, which is what decides whether to keep polling. */
  building: boolean;
  roleDeleting: boolean;
  stateDeleting: boolean;
  roleRunning: boolean;
  roleFailed: boolean;
  stateRunning: boolean;
  stateFailed: boolean;
}

export function deployStepsView(input: DeployStepsInput): DeployStepsView {
  const {
    connection,
    setup,
    chosen,
    busy,
    roleStack,
    stateStack,
    deleting,
    roleFailure,
    stateFailure,
  } = input;

  // CloudFormation answers the moment it accepts the request, so whether it
  // worked is always a later question.
  // A deletion counts: it is the same "CloudFormation is working on it, ask again
  // shortly", and it is the poll that tells us when a create may be offered again.
  /**
   * Each stack's own in-flight work: its deletion, or CloudFormation still moving.
   *
   * Separate per stack, because one shared flag disabled both steps' controls and
   * made a teardown impossible — starting on the role left Delete on the state
   * greyed out with nothing to explain it. What each may block is not symmetric
   * either, and the wizard's buttons say which: a *delete* only waits on its own
   * stack, while *creating* the state waits on the role as well, because the state
   * key's policy names the role and a policy naming a principal mid-deletion is
   * rejected outright.
   */
  const roleBusy =
    deleting.role !== undefined || (roleStack !== null && !roleStack.settled);
  const stateBusy =
    deleting.state !== undefined ||
    (stateStack !== null && !stateStack.settled);

  /** Anything at all, which is what decides whether to keep polling. */
  const building = roleBusy || stateBusy;

  const roleDeleting = isStackDeleting(roleStack, deleting.role);
  const stateDeleting = isStackDeleting(stateStack, deleting.state);

  const done: Record<StepId, boolean> = {
    account: connection?.connected ?? false,
    // Both halves of the step: the role exists, and the pipeline can find it.
    role: setup.roleReady && setup.variablesReady,
    state: setup.stateReady,
    pipeline: setup.pipelineReady,
  };

  /** The role step has work in flight: the stack itself, or the save after it. */
  const roleRunning =
    busy === "role" ||
    busy === "role-variables" ||
    deleting.role !== undefined ||
    (roleStack !== null && !roleStack.settled);

  /**
   * The last attempt did not leave a usable stack.
   *
   * Two ways to be true, because a create made with `OnFailure: DELETE` erases
   * its own evidence: either the stack is still there and settled unsuccessfully,
   * or it is gone and `roleFailure` is what it said on the way out.
   */
  const roleFailed =
    roleFailure !== null || Boolean(roleStack?.settled && !roleStack.succeeded);

  // Two ways to be true, exactly as on the role step: the stack is still there and
  // settled unsuccessfully, or it erased itself and `stateFailure` is what it said
  // on the way out.
  const stateFailed =
    stateFailure !== null ||
    Boolean(stateStack?.settled && !stateStack.succeeded);

  /** The state step's counterpart of `roleRunning`: stack, save or deletion. */
  const stateRunning =
    busy === "state" ||
    deleting.state !== undefined ||
    (stateStack !== null && !stateStack.settled);

  /**
   * The AWS session this wizard needs is gone, and every step but the first one
   * depends on it.
   *
   * Null is not "lost": before the first read nothing is known, and treating that
   * as a lost connection would flash step one at everybody on arrival.
   *
   * Worth being strict about, because losing it does not look like losing it. The
   * role and the state stay recorded on the project, so their steps go on reporting
   * themselves finished, the strip goes on offering them, and their buttons go on
   * looking pressable — until one is pressed and fails on credentials, having
   * already been counted as a step that ran.
   */
  const awsLost = connection !== null && !connection.connected;

  /** True once this project has a setup that a reconnect would return it to. */
  const hadProgress = setup.roleReady || setup.stateReady;

  /** Where the work actually stands, regardless of what is being looked at. */
  const nextUnfinished = ORDER.find((id) => !done[id]) ?? FINAL_STEP;

  // The override outranks `chosen` on purpose: a step the user picked before the
  // session expired must not stay open just because they picked it.
  const current = awsLost ? "account" : (chosen ?? nextUnfinished);

  return {
    done,
    current,
    index: ORDER.indexOf(current),
    nextUnfinished,
    awsLost,
    hadProgress,
    roleBusy,
    stateBusy,
    building,
    roleDeleting,
    stateDeleting,
    roleRunning,
    roleFailed,
    stateRunning,
    stateFailed,
  };
}
