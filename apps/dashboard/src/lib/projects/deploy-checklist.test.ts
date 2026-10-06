import { describe, expect, it } from "vitest";

import {
  buildRoleChecklist,
  buildStateChecklist,
  type ChecklistStack,
  cloudFormationConsoleUrl,
} from "./deploy-checklist";

/**
 * The role step's checklist, and the console link on it.
 *
 * Written from the states the wizard actually reaches rather than from the branches
 * in the code, because the bugs this caught were all of the form "two lines
 * contradict each other": a stack reported as still building under a finished tick, a
 * link to a stack that had just been deleted, a warning printed under a step that had
 * not run.
 */

const ROLE_ARN =
  "arn:aws:cloudformation:eu-central-1:545283928770:stack/terrablox-shop-bootstrap/abc-123";

const stack = (
  status: string,
  settled: boolean,
  succeeded: boolean,
  stackId: string | null = ROLE_ARN,
): ChecklistStack => ({ status, settled, succeeded, stackId });

const CREATED = stack("CREATE_COMPLETE", true, true);

type Input = Parameters<typeof buildRoleChecklist>[0];

const base: Input = {
  stack: null,
  failure: null,
  busy: null,
  roleReady: false,
  variablesReady: false,
  saveFailed: false,
  variablesError: null,
  oidcProvider: null,
  repoFullName: "t3bld/terrablox-mhp-infrastructure",
};

/** A setup that got all the way through, for the cases that vary after that. */
const finished: Input = {
  ...base,
  stack: CREATED,
  roleReady: true,
  variablesReady: true,
  oidcProvider: "ready",
};

const states = (input: Input) => buildRoleChecklist(input).map((i) => i.state);
const line = (input: Input, id: string) =>
  buildRoleChecklist(input).find((i) => i.id === id) ?? null;

describe("buildRoleChecklist", () => {
  it("names the four things the step does, in the order it does them", () => {
    expect(buildRoleChecklist(base).map((i) => i.id)).toEqual([
      "stack",
      "oidc",
      "record",
      "variables",
    ]);
  });

  it("claims nothing before anything has run", () => {
    expect(states(base)).toEqual(["pending", "pending", "pending", "pending"]);
  });

  it("walks a first-time setup from create to done", () => {
    expect(states({ ...base, busy: "role" })[0]).toBe("active");
    expect(
      states({ ...base, stack: stack("CREATE_IN_PROGRESS", false, false) })[0],
    ).toBe("active");
    expect(states({ ...base, stack: CREATED, busy: "role-variables" })).toEqual(
      ["done", "pending", "active", "active"],
    );
    expect(states(finished)).toEqual(["done", "done", "done", "done"]);
  });

  describe("the stack line's detail", () => {
    it("explains a stack that is missing under the name the project holds", () => {
      // The drift case: the project believes it was set up, and nothing here answers
      // to the name. Without this the line is grey next to two green ones below it.
      expect(
        line(
          {
            ...base,
            driftNote: "No stack called terrablox-shop-bootstrap in eu-west-1.",
          },
          "stack",
        )?.detail,
      ).toBe("No stack called terrablox-shop-bootstrap in eu-west-1.");
    });

    it("says nothing once a stack answers, including while it is still moving", () => {
      // CloudFormation's own status used to be here. It is not any more, and both of
      // its jobs are done better elsewhere: a deletion replaces the whole step with a
      // waiting state that shows the raw status, and for a create the spinner is the
      // whole of what a status word would add.
      expect(
        line(
          { ...base, stack: stack("CREATE_IN_PROGRESS", false, false) },
          "stack",
        )?.detail,
      ).toBeNull();
      expect(line({ ...base, stack: CREATED }, "stack")?.detail).toBeNull();
    });

    it("drops the drift note as soon as a stack is found again", () => {
      expect(
        line({ ...base, stack: CREATED, driftNote: "stale" }, "stack")?.detail,
      ).toBeNull();
    });
  });

  describe("failures land on the line they belong to", () => {
    it("marks a stack that settled unsuccessfully", () => {
      expect(
        states({ ...base, stack: stack("ROLLBACK_COMPLETE", true, false) })[0],
      ).toBe("failed");
    });

    it("marks one that rolled back and erased its own evidence", () => {
      // `OnFailure: DELETE` removes the stack, so there is nothing left to describe
      // and the reason is all the caller still has.
      expect(
        states({ ...base, failure: "OIDC provider already exists" })[0],
      ).toBe("failed");
    });

    it("keeps the role green when only the repository write failed", () => {
      expect(
        states({
          ...finished,
          variablesReady: false,
          variablesError: "no permission",
        }),
      ).toEqual(["done", "done", "done", "failed"]);
    });

    it("never reports a later line as done while the stack is not", () => {
      for (const s of [
        null,
        stack("CREATE_IN_PROGRESS", false, false),
        stack("ROLLBACK_COMPLETE", true, false),
      ]) {
        expect(
          buildRoleChecklist({ ...base, stack: s })
            .slice(1)
            .every((i) => i.state !== "done"),
        ).toBe(true);
      }
    });
  });

  describe("the identity provider, which is account-wide and therefore shared", () => {
    it("passes only when it accepts the audience the role asks for", () => {
      expect(line(finished, "oidc")?.state).toBe("done");
      expect(line(finished, "oidc")?.detail).toBeNull();
    });

    it("fails when the account has none", () => {
      const missing = { ...finished, oidcProvider: "missing" as const };
      expect(line(missing, "oidc")?.state).toBe("failed");
      expect(line(missing, "oidc")?.detail).toContain("Not in this account");
    });

    it("fails differently when one exists for another audience", () => {
      // The case that survived a full teardown and rebuild: present, so nothing
      // created it again, and useless, so no deploy could assume the role.
      const wrong = { ...finished, oidcProvider: "wrong-audience" as const };
      expect(line(wrong, "oidc")?.state).toBe("failed");
      expect(line(wrong, "oidc")?.detail).toContain("sts.amazonaws.com");
      expect(line(wrong, "oidc")?.detail).not.toBe(
        line({ ...finished, oidcProvider: "missing" }, "oidc")?.detail,
      );
    });

    it("stays unchecked rather than red when IAM could not be asked", () => {
      const unknown = { ...finished, oidcProvider: null };
      expect(line(unknown, "oidc")?.state).toBe("pending");
      expect(line(unknown, "oidc")?.detail).toContain("Could not check");
    });

    it("says nothing at all until the stack has finished", () => {
      // Both halves: the state *and* the detail. Only the caller's habit of
      // reporting nothing until then used to keep the warning off the screen.
      for (const provider of [
        "ready",
        "missing",
        "wrong-audience",
        null,
      ] as const) {
        for (const s of [
          null,
          stack("CREATE_IN_PROGRESS", false, false),
          stack("ROLLBACK_COMPLETE", true, false),
        ]) {
          const l = line({ ...base, stack: s, oidcProvider: provider }, "oidc");
          expect(l?.state, `provider=${provider} status=${s?.status}`).toBe(
            "pending",
          );
          expect(
            l?.detail,
            `provider=${provider} status=${s?.status}`,
          ).toBeNull();
        }
      }
    });
  });

  describe("a rebuild that had nothing to change", () => {
    // The complaint this answers: rebuilding a finished setup left the last two
    // lines green and silent, which is indistinguishable from a run that skipped
    // them. They were skipped, correctly — the values were already right.
    it("says so on the lines that were already done", () => {
      const input = {
        ...finished,
        recordUnchanged: true,
        variablesUnchanged: true,
      };

      expect(line(input, "record")?.detail).toMatch(/already stored/i);
      expect(line(input, "variables")?.detail).toMatch(/already set/i);
    });

    it("still shows them as done, because they are", () => {
      const input = {
        ...finished,
        recordUnchanged: true,
        variablesUnchanged: true,
      };

      expect(line(input, "record")?.state).toBe("done");
      expect(line(input, "variables")?.state).toBe("done");
    });

    it("cannot make an unfinished line look finished", () => {
      // The flags only ever annotate. A caller passing them for a step that has not
      // run must not turn a grey line green.
      const input = {
        ...base,
        recordUnchanged: true,
        variablesUnchanged: true,
      };

      expect(line(input, "record")?.state).toBe("pending");
      expect(line(input, "variables")?.state).toBe("pending");
      expect(line(input, "record")?.detail).toBeNull();
    });

    it("stays quiet on a first run, where every tick is this run's work", () => {
      expect(line(finished, "record")?.detail).toBeNull();
      expect(line(finished, "variables")?.detail).toBeNull();
    });

    it("does not bury a variables error under the unchanged note", () => {
      // A failure is the more urgent thing to say, and `ready` is false there
      // anyway — so the note must not win.
      const input = {
        ...finished,
        variablesReady: false,
        variablesError: "GitHub refused to write the variables.",
        variablesUnchanged: true,
      };

      expect(line(input, "variables")?.detail).toBe(
        "GitHub refused to write the variables.",
      );
      expect(line(input, "variables")?.state).toBe("failed");
    });
  });

  describe("the link to the stack", () => {
    it("appears once there is something to look at", () => {
      expect(line({ ...base, stack: CREATED }, "stack")?.link).toEqual({
        href: expect.stringContaining("eu-central-1"),
        label: "Open the stack in AWS",
      });
    });

    it("stays away while building, where the page would contradict the spinner", () => {
      expect(
        line(
          { ...base, stack: stack("CREATE_IN_PROGRESS", false, false) },
          "stack",
        )?.link,
      ).toBeNull();
    });

    it("stays away after a failure, where it would be a 404", () => {
      expect(
        line(
          { ...base, stack: stack("ROLLBACK_COMPLETE", true, false) },
          "stack",
        )?.link,
      ).toBeNull();
      expect(line({ ...base, failure: "boom" }, "stack")?.link).toBeNull();
    });

    it("is omitted rather than guessed when no ARN came back", () => {
      expect(
        line({ ...base, stack: { ...CREATED, stackId: null } }, "stack")?.link,
      ).toBeNull();
    });
  });
});

describe("buildStateChecklist on a rebuild", () => {
  const finishedState: Parameters<typeof buildStateChecklist>[0] = {
    stack: CREATED,
    failure: null,
    busy: null,
    stateReady: true,
    variablesReady: true,
    saveFailed: false,
    variablesError: null,
    bucket: "mhp-tfstate-123456789012-a1b2",
    repoFullName: "t3bld/terrablox-mhp-infrastructure",
  };

  const stateLine = (
    input: Parameters<typeof buildStateChecklist>[0],
    id: string,
  ) => buildStateChecklist(input).find((i) => i.id === id) ?? null;

  it("keeps the bucket name and adds that nothing changed", () => {
    // The name stays first: it is what the backend file will contain, and the only
    // thing on this line somebody needs to recognise later.
    const detail = stateLine(
      { ...finishedState, recordUnchanged: true },
      "record",
    )?.detail;

    expect(detail).toContain("mhp-tfstate-123456789012-a1b2");
    expect(detail).toMatch(/unchanged/i);
  });

  it("shows the bucket name alone on a first run", () => {
    expect(stateLine(finishedState, "record")?.detail).toBe(
      "mhp-tfstate-123456789012-a1b2",
    );
  });

  it("annotates the variables line, which is the one that looked skipped", () => {
    expect(
      stateLine({ ...finishedState, variablesUnchanged: true }, "variables")
        ?.detail,
    ).toMatch(/already set/i);
  });
});

describe("cloudFormationConsoleUrl", () => {
  it("takes the region from the ARN, not from the project's settings", () => {
    // The ARN says where the stack really is. Read from the project instead, the link
    // would point at an empty console after somebody changed the region.
    expect(cloudFormationConsoleUrl(ROLE_ARN)).toBe(
      `https://eu-central-1.console.aws.amazon.com/cloudformation/home?region=eu-central-1#/stacks/stackinfo?stackId=${encodeURIComponent(ROLE_ARN)}`,
    );
  });

  it("encodes the ARN, so its slashes survive the fragment", () => {
    expect(cloudFormationConsoleUrl(ROLE_ARN)).not.toMatch(/stackId=arn:aws/);
  });

  it("uses the right console for the partitions that are their own AWS", () => {
    expect(
      cloudFormationConsoleUrl(
        "arn:aws-cn:cloudformation:cn-north-1:1:stack/x/y",
      ),
    ).toContain("https://cn-north-1.console.amazonaws.cn/");
    expect(
      cloudFormationConsoleUrl(
        "arn:aws-us-gov:cloudformation:us-gov-west-1:1:stack/x/y",
      ),
    ).toContain("https://us-gov-west-1.console.amazonaws-us-gov.com/");
  });

  it("returns nothing rather than a dead link", () => {
    // A link into somebody's AWS account that 404s reads as "the stack is not there".
    for (const junk of [
      null,
      undefined,
      "",
      "not-an-arn",
      "arn:aws:cloudformation",
    ]) {
      expect(cloudFormationConsoleUrl(junk), String(junk)).toBeNull();
    }
  });
});
