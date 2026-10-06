import { describe, expect, it } from "vitest";

import {
  type BootstrapStack,
  type DeployStepsInput,
  deployStepsView,
  isStackDeleting,
  ORDER,
  showDeployWizard,
} from "./deploy-steps";

/**
 * The deploy wizard's step machine.
 *
 * Every assertion here stands for a bug that shipped. The wizard is four steps over two
 * CloudFormation stacks, an OAuth session that can expire mid-setup, and a project record
 * that outlives both — so "which step am I on" has more wrong answers than right ones, and
 * each wrong one needed an exact sequence of clicks to reproduce in a browser.
 *
 * What is deliberately not tested: the fetching, the toasts and the JSX. Those stayed in the
 * component. This is the part with the decisions in it.
 */

function stack(extra: Partial<BootstrapStack> = {}): BootstrapStack {
  return {
    stackName: "terrablox-role",
    stackId:
      "arn:aws:cloudformation:eu-central-1:123456789012:stack/terrablox-role/abc",
    status: "CREATE_COMPLETE",
    statusReason: null,
    settled: true,
    succeeded: true,
    outputs: {},
    ...extra,
  };
}

function input(extra: Partial<DeployStepsInput> = {}): DeployStepsInput {
  return {
    connection: { connected: true },
    setup: {
      roleReady: false,
      variablesReady: false,
      stateReady: false,
      pipelineReady: false,
      complete: false,
    },
    chosen: null,
    busy: null,
    roleStack: null,
    stateStack: null,
    deleting: {},
    roleFailure: null,
    stateFailure: null,
    ...extra,
  };
}

/** Everything finished, which is the state the last step has to survive. */
const allDone = {
  roleReady: true,
  variablesReady: true,
  stateReady: true,
  pipelineReady: true,
  complete: true,
};

describe("isStackDeleting", () => {
  it("is false with no stack and nothing tracked", () => {
    expect(isStackDeleting(null, undefined)).toBe(false);
  });

  it("is true for a deletion this tab started, before AWS has said anything", () => {
    expect(isStackDeleting(null, "terrablox-role")).toBe(true);
  });

  it("notices a deletion started in the AWS console", () => {
    // Reads the status, not just our own flag: a stack removed from the AWS side
    // would otherwise go on showing a step that describes it.
    expect(
      isStackDeleting(
        stack({ status: "DELETE_IN_PROGRESS", settled: false }),
        undefined,
      ),
    ).toBe(true);
  });

  it("is false once the deletion has finished", () => {
    // `DELETE_COMPLETE` is settled, so it is not "coming down" — it is gone, and
    // the step is honest again.
    expect(
      isStackDeleting(
        stack({ status: "DELETE_COMPLETE", settled: true, succeeded: true }),
        undefined,
      ),
    ).toBe(false);
  });

  it("is false while a stack is being created", () => {
    expect(
      isStackDeleting(
        stack({ status: "CREATE_IN_PROGRESS", settled: false }),
        undefined,
      ),
    ).toBe(false);
  });
});

describe("which step is current", () => {
  it("starts on the account step before an account is connected", () => {
    const view = deployStepsView(input({ connection: null }));

    expect(view.current).toBe("account");
    expect(view.index).toBe(0);
    expect(view.done.account).toBe(false);
  });

  it("counts a connected account as step one done and moves to the role", () => {
    // Signing in completes step one, so the wizard must not sit on it — but the
    // region lives on that screen too, which is why connecting *here* pins the
    // view (in the component) rather than this deciding to skip past it.
    const view = deployStepsView(input());

    expect(view.done).toEqual({
      account: true,
      role: false,
      state: false,
      pipeline: false,
    });
    expect(view.current).toBe("role");
    expect(view.index).toBe(1);
  });

  it("walks forward as each step finishes", () => {
    const at = (setup: DeployStepsInput["setup"]) =>
      deployStepsView(input({ setup })).current;

    expect(
      at({
        ...allDone,
        roleReady: false,
        variablesReady: false,
        stateReady: false,
        pipelineReady: false,
        complete: false,
      }),
    ).toBe("role");
    expect(
      at({
        ...allDone,
        stateReady: false,
        pipelineReady: false,
        complete: false,
      }),
    ).toBe("state");
    expect(at({ ...allDone, pipelineReady: false, complete: false })).toBe(
      "pipeline",
    );
  });

  it("stays on the last step once everything is done", () => {
    // `nextUnfinished` has to fall back rather than go undefined.
    const view = deployStepsView(input({ setup: allDone }));

    expect(view.nextUnfinished).toBe("pipeline");
    expect(view.current).toBe("pipeline");
    expect(view.index).toBe(ORDER.length - 1);
  });

  it("needs both halves of the role step before moving on", () => {
    // The stack is only any use once the ARN it produced is where the workflow
    // looks for it, so a wizard that counted those separately made the second
    // look optional.
    const view = deployStepsView(
      input({
        setup: {
          roleReady: true,
          variablesReady: false,
          stateReady: false,
          pipelineReady: false,
          complete: false,
        },
      }),
    );

    expect(view.done.role).toBe(false);
    expect(view.current).toBe("role");
  });

  it("shows the step the user picked instead of the unfinished one", () => {
    const view = deployStepsView(input({ chosen: "pipeline" }));

    expect(view.current).toBe("pipeline");
    // What is actually outstanding does not move just because of what is on screen.
    expect(view.nextUnfinished).toBe("role");
  });
});

describe("a lost AWS session", () => {
  it("is not the same as not having read yet", () => {
    // Null before the first read. Treating that as lost would flash step one at
    // everybody on arrival.
    const unread = deployStepsView(
      input({ connection: null, chosen: "state" }),
    );

    expect(unread.awsLost).toBe(false);
    expect(unread.current).toBe("state");
  });

  it("forces the wizard back to the account step", () => {
    const view = deployStepsView(
      input({ connection: { connected: false }, setup: allDone }),
    );

    expect(view.awsLost).toBe(true);
    expect(view.current).toBe("account");
  });

  it("outranks a step the user picked before the session expired", () => {
    const view = deployStepsView(
      input({ connection: { connected: false }, chosen: "pipeline" }),
    );

    expect(view.current).toBe("account");
  });

  it("still reports the recorded progress, so a reconnect can be offered", () => {
    // The role and the state stay recorded on the project. The steps must not go
    // on looking pressable, but the wizard does have to be able to say there is
    // something to come back to.
    const view = deployStepsView(
      input({
        connection: { connected: false },
        setup: { ...allDone, pipelineReady: false, complete: false },
      }),
    );

    expect(view.hadProgress).toBe(true);
    expect(view.done.role).toBe(true);
    expect(view.current).toBe("account");
  });

  it("reports no progress on a project that never got started", () => {
    expect(
      deployStepsView(input({ connection: { connected: false } })).hadProgress,
    ).toBe(false);
  });
});

describe("what is in flight", () => {
  it("is quiet when nothing is happening", () => {
    const view = deployStepsView(input());

    expect(view.building).toBe(false);
    expect(view.roleBusy).toBe(false);
    expect(view.stateBusy).toBe(false);
    expect(view.roleRunning).toBe(false);
    expect(view.stateRunning).toBe(false);
  });

  it("keeps the two stacks' busy flags apart", () => {
    // One shared flag made a teardown impossible: starting on the role left
    // Delete on the state greyed out with nothing to explain it.
    const view = deployStepsView(
      input({ roleStack: stack({ settled: false }) }),
    );

    expect(view.roleBusy).toBe(true);
    expect(view.stateBusy).toBe(false);
    expect(view.building).toBe(true);
  });

  it("counts a deletion as work in flight", () => {
    const view = deployStepsView(input({ deleting: { state: "tb-state" } }));

    expect(view.stateBusy).toBe(true);
    expect(view.stateDeleting).toBe(true);
    // The poll is what tells us when a create may be offered again.
    expect(view.building).toBe(true);
  });

  it("treats the role save as the role step running", () => {
    // Two buttons, one step: a spinner driven by the stack alone would show the
    // stack being created while the thing actually running is the save.
    expect(deployStepsView(input({ busy: "role-variables" })).roleRunning).toBe(
      true,
    );
    expect(deployStepsView(input({ busy: "role" })).roleRunning).toBe(true);
    expect(deployStepsView(input({ busy: "state" })).roleRunning).toBe(false);
  });

  it("does not confuse the two steps' spinners", () => {
    const view = deployStepsView(input({ busy: "state" }));

    expect(view.stateRunning).toBe(true);
    expect(view.roleRunning).toBe(false);
  });
});

describe("a failed attempt", () => {
  it("reads a settled, unsuccessful stack as failed", () => {
    const view = deployStepsView(
      input({
        roleStack: stack({ status: "ROLLBACK_COMPLETE", succeeded: false }),
      }),
    );

    expect(view.roleFailed).toBe(true);
  });

  it("reads a reported failure as failed even with no stack left", () => {
    // A create made with `OnFailure: DELETE` erases its own evidence, so the
    // message is the only thing that survives it.
    const view = deployStepsView(
      input({ roleStack: null, roleFailure: "Insufficient permissions." }),
    );

    expect(view.roleFailed).toBe(true);
  });

  it("does not call a stack still working failed", () => {
    expect(
      deployStepsView(input({ roleStack: stack({ settled: false }) }))
        .roleFailed,
    ).toBe(false);
  });

  it("does not call a successful stack failed", () => {
    expect(deployStepsView(input({ roleStack: stack() })).roleFailed).toBe(
      false,
    );
  });

  it("keeps the two steps' failures apart", () => {
    const view = deployStepsView(input({ stateFailure: "Bucket exists." }));

    expect(view.stateFailed).toBe(true);
    expect(view.roleFailed).toBe(false);
  });
});

/**
 * Which of the two views the deploy tab shows.
 *
 * Split out of the panel because the interesting part is a precedence, and the
 * precedence was wrong in one direction that nobody notices until they use the feature
 * twice: `reconfiguring` beats a finished setup, so pressing Finalize left the tab
 * sitting in the wizard with every step ticked.
 *
 * What this covers is the truth table — that the override really does outrank
 * completion, which is the property the finish path has to work with. What it cannot
 * cover is the finish path itself: clearing the flag happens in a React callback, and
 * there is no DOM environment here on purpose (see `vitest.config.ts`). So the guarantee
 * is split — this pins the rule, and the comment on `showDeployWizard` states the
 * obligation it puts on the caller.
 */
describe("showDeployWizard", () => {
  it("shows nothing until the first read lands", () => {
    // Neither view is right yet. Flashing the wizard at somebody whose setup is
    // finished is the failure this prevents.
    expect(
      showDeployWizard({
        configured: null,
        reconfiguring: false,
        awsAccountId: "123456789012",
      }),
    ).toBe(false);
  });

  it("shows the wizard while the setup is unfinished", () => {
    expect(
      showDeployWizard({
        configured: false,
        reconfiguring: false,
        awsAccountId: "123456789012",
      }),
    ).toBe(true);
  });

  it("shows the configuration once the setup is complete", () => {
    expect(
      showDeployWizard({
        configured: true,
        reconfiguring: false,
        awsAccountId: "123456789012",
      }),
    ).toBe(false);
  });

  it("lets a reconfigure override a finished setup", () => {
    // Deliberate: this is what "Change the setup" does. It is also the trap — the flag
    // outranks completion, so whoever sets it owes a clear on every way out, including
    // finishing.
    expect(
      showDeployWizard({
        configured: true,
        reconfiguring: true,
        awsAccountId: "123456789012",
      }),
    ).toBe(true);
  });

  it("returns to the configuration when the reconfigure flag is cleared", () => {
    // The state after Finalize: complete, and the flag cleared by the completion
    // handler. If this reads true, the tab is stuck in the wizard.
    expect(
      showDeployWizard({
        configured: true,
        reconfiguring: false,
        awsAccountId: "123456789012",
      }),
    ).toBe(false);
  });

  it("reopens the wizard when the project points at no account", () => {
    // The role and the bucket may still exist, but nothing in the tab can be created
    // or re-read until an account is attached again.
    expect(
      showDeployWizard({
        configured: true,
        reconfiguring: false,
        awsAccountId: null,
      }),
    ).toBe(true);
  });
});
