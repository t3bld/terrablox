import { describe, expect, it } from "vitest";

import type { Stack } from "./stack.js";
import { checkStack, hasBlocking } from "./validate.js";

/**
 * Tests against the real catalogue rather than a fixture.
 *
 * A fixture would let these pass while the thing they describe was wrong: the point of the
 * checker is that it knows the *actual* interface of an actual module at an actual tag, and
 * a hand-written stand-in only proves the code can read a hand-written stand-in. The cost
 * is that a regenerated snapshot can break a test — which is the correct outcome, because
 * it means a module's interface changed and something that reads it should be looked at.
 *
 * `acm` and `elb` are the anchors: `acm` has a small, untruncated interface, and `elb` is
 * the module with the most required inputs (four), so between them they cover both sides of
 * the truncation rule.
 */

const stack = (calls: Stack["calls"]): Stack => ({ calls });

const kinds = (s: Stack) => checkStack(s).map((problem) => problem.kind);

describe("checkStack", () => {
  it("passes a call that satisfies the interface", () => {
    const problems = checkStack(
      stack([
        {
          module: "acm",
          name: "cert",
          arguments: { domain_name: "example.com" },
        },
      ]),
    );

    expect(problems).toEqual([]);
    expect(hasBlocking(problems)).toBe(false);
  });

  it("reports an argument the module does not declare, with a suggestion", () => {
    const problems = checkStack(
      stack([
        {
          module: "acm",
          name: "cert",
          arguments: { domian_name: "example.com" },
        },
      ]),
    );

    const unknown = problems.find((p) => p.kind === "unknown-argument");
    expect(unknown?.severity).toBe("blocking");
    expect(unknown?.confidence).toBe("certain");
    // The suggestion is the reason this costs a turn one call instead of a wrong commit.
    expect(unknown?.message).toContain('did you mean "domain_name"');
  });

  it("will not call an argument unknown when the snapshot truncated the interface", () => {
    // `vpc` declares far more inputs than the snapshot keeps, so absence here is genuinely
    // not evidence. Reporting this as blocking would tell an agent to delete something real.
    const problems = checkStack(
      stack([
        { module: "vpc", name: "network", arguments: { made_up_xyz: "1" } },
      ]),
    );

    const unknown = problems.find((p) => p.kind === "unknown-argument");
    expect(unknown?.severity).toBe("warning");
    expect(unknown?.confidence).toBe("unverifiable");
    expect(hasBlocking(problems)).toBe(false);
  });

  it("reports required inputs that are unset", () => {
    const problems = checkStack(stack([{ module: "elb", name: "lb" }]));
    const missing = problems.filter((p) => p.kind === "missing-input");

    // Four, and every one certain: required inputs sort first in the snapshot, so the cap
    // never hides one.
    expect(missing).toHaveLength(4);
    expect(missing.every((p) => p.confidence === "certain")).toBe(true);
    expect(missing.every((p) => p.severity === "blocking")).toBe(true);
  });

  it("reports a value whose type cannot match, coercing bare strings first", () => {
    // `health_check` is `map(string)`. A bare word is a string once coerced, and a string
    // is not a map — without the coercion this reads as an expression and goes unjudged.
    const problems = checkStack(
      stack([
        { module: "elb", name: "lb", arguments: { health_check: "nope" } },
      ]),
    );

    expect(
      kinds(
        stack([
          { module: "elb", name: "lb", arguments: { health_check: "nope" } },
        ]),
      ),
    ).toContain("type-mismatch");
    expect(problems.find((p) => p.kind === "type-mismatch")?.severity).toBe(
      "blocking",
    );
  });

  it("reports a reference to a label the stack does not hold", () => {
    const problems = checkStack(
      stack([
        {
          module: "acm",
          name: "cert",
          arguments: { domain_name: "module.absent.name" },
        },
      ]),
    );

    const dangling = problems.find((p) => p.kind === "dangling-module");
    expect(dangling?.severity).toBe("blocking");
    expect(dangling?.message).toContain("module.absent");
  });

  it("accepts a reference to a label declared later in the stack", () => {
    // Terraform does not care about order, so neither may this.
    const problems = checkStack(
      stack([
        {
          module: "acm",
          name: "cert",
          arguments: { domain_name: "module.later.tag" },
        },
        { module: "vpc", name: "later" },
      ]),
    );

    expect(problems.map((p) => p.kind)).not.toContain("dangling-module");
  });

  it("still checks references inside an argument it cannot verify", () => {
    // The gap a probe against the running server exposed: an unverifiable argument used to
    // end the check for that value, so a dangling reference inside it went unreported.
    const problems = checkStack(
      stack([
        {
          module: "vpc",
          name: "network",
          arguments: { made_up_xyz: "module.ghost.id" },
        },
      ]),
    );

    expect(problems.map((p) => p.kind)).toContain("dangling-module");
  });

  it("reports a module that is not in the catalogue", () => {
    const problems = checkStack(stack([{ module: "not-a-module", name: "x" }]));
    expect(problems[0]?.kind).toBe("unknown-module");
    expect(problems[0]?.severity).toBe("blocking");
  });

  it("resolves a module named with the wrong separators or its display name", () => {
    expect(kinds(stack([{ module: "rds_aurora", name: "db" }]))).not.toContain(
      "unknown-module",
    );
    expect(
      kinds(
        stack([
          {
            module: "Certificate Manager",
            name: "cert",
            arguments: { domain_name: "a.example" },
          },
        ]),
      ),
    ).toEqual([]);
  });

  it("reports two calls sharing a label", () => {
    const problems = checkStack(
      stack([
        {
          module: "acm",
          name: "same",
          arguments: { domain_name: "a.example" },
        },
        { module: "vpc", name: "same" },
      ]),
    );

    expect(problems.map((p) => p.kind)).toContain("duplicate-label");
  });

  it("rejects a label Terraform would not accept", () => {
    const problems = checkStack(stack([{ module: "acm", name: "9-lives" }]));
    expect(problems[0]?.kind).toBe("invalid-label");
  });

  it("reports a module reading its own output", () => {
    const problems = checkStack(
      stack([
        {
          module: "acm",
          name: "cert",
          arguments: { domain_name: "module.cert.domain_name" },
        },
      ]),
    );

    expect(problems.map((p) => p.kind)).toContain("self-reference");
  });

  it("puts blocking findings before warnings", () => {
    const problems = checkStack(
      stack([
        { module: "vpc", name: "network", arguments: { made_up_xyz: "1" } },
        { module: "elb", name: "lb" },
      ]),
    );

    const firstWarning = problems.findIndex((p) => p.severity === "warning");
    const lastBlocking = problems.reduce(
      (last, problem, index) =>
        problem.severity === "blocking" ? index : last,
      -1,
    );

    expect(lastBlocking).toBeLessThan(firstWarning);
  });
});
