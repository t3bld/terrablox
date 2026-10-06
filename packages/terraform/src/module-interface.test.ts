import { describe, expect, it } from "vitest";

import {
  type BlockInterface,
  checkArgument,
  checkArguments,
  checkReferences,
  missingRequiredInputs,
} from "./module-interface";

/**
 * The safety net for the migration this function exists to enable.
 *
 * Two implementations of this check were merged into one — the dashboard's graph
 * projection and the MCP server's stack check — and neither had a test. These are written
 * against the merged behaviour before either caller is switched over, so a regression in
 * the switch shows up here rather than in somebody's repository.
 */

const vpc = (over: Partial<BlockInterface> = {}): BlockInterface => ({
  label: "network",
  inputs: [
    { name: "name", type: "string", required: true },
    { name: "cidr", type: "string" },
    { name: "azs", type: "list(string)" },
    { name: "tags", type: "map(string)" },
  ],
  outputs: [{ name: "vpc_id" }, { name: "private_subnets" }],
  ...over,
});

describe("checkArgument", () => {
  it("accepts a declared argument whose value fits the type", () => {
    expect(checkArgument(vpc(), "cidr", "10.0.0.0/16")).toEqual([]);
  });

  it("rejects an argument the module does not declare, and suggests the near miss", () => {
    const [finding] = checkArgument(vpc(), "cidrr", "10.0.0.0/16");

    expect(finding?.kind).toBe("unknown-argument");
    expect(finding?.confidence).toBe("certain");
    expect(finding?.subject).toBe("cidrr");
    expect(finding?.message).toContain('did you mean "cidr"');
  });

  it("offers no suggestion when nothing is close", () => {
    const [finding] = checkArgument(vpc(), "completely_unrelated", "x");

    expect(finding?.kind).toBe("unknown-argument");
    expect(finding?.message).not.toContain("did you mean");
  });

  it("coerces a bare string before judging its type", () => {
    // The divergence that made this extraction worth doing: the projection checked the
    // raw value, so `production` looked like an expression whose shape nothing judges,
    // and a list input given a bare word passed. Coerced, it is a string and is caught.
    const [finding] = checkArgument(vpc(), "azs", "production");

    expect(finding?.kind).toBe("type-mismatch");
    expect(finding?.message).toContain("network.azs");
  });

  it("leaves a real expression alone", () => {
    // `module.other.subnets` is a reference; its shape cannot be known here, and
    // inventing a mismatch would refuse a correct edit.
    expect(checkArgument(vpc(), "azs", "module.other.subnets")).toEqual([]);
  });

  it("never reports a type mismatch for an undeclared argument", () => {
    // There is no declared type to compare against, so two findings would be one
    // finding and a guess.
    const findings = checkArgument(
      vpc(),
      "not_a_port",
      "definitely not a list",
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("unknown-argument");
  });

  describe("when the interface is only partly known", () => {
    const partial = vpc({
      knowledge: "partial",
      source: "terrablox/terrablox-aws-vpc at v6.6.1",
      omitted: { inputs: 196 },
    });

    it("reports an unknown argument as unverifiable, not as wrong", () => {
      const [finding] = checkArgument(partial, "enable_nat_gateway", "true");

      expect(finding?.kind).toBe("unknown-argument");
      expect(finding?.confidence).toBe("unverifiable");
      // Telling somebody to delete a legitimate argument is worse than saying nothing,
      // so the message has to name where the truth is.
      expect(finding?.message).toContain("196 more were omitted");
      expect(finding?.message).toContain(
        "terrablox/terrablox-aws-vpc at v6.6.1",
      );
    });

    it("still checks the type of an argument it does know", () => {
      const [finding] = checkArgument(partial, "azs", "production");
      expect(finding?.kind).toBe("type-mismatch");
      expect(finding?.confidence).toBe("certain");
    });
  });

  describe("when the interface is unknown", () => {
    const opaque = vpc({ knowledge: "unknown", inputs: [], outputs: [] });

    it("says nothing at all", () => {
      // A `module` block written by hand against a source nobody imported. Refusing
      // every edit to a block we cannot describe would be worse than not checking it.
      expect(checkArgument(opaque, "anything", "at all")).toEqual([]);
    });
  });
});

describe("checkArguments", () => {
  it("reports each argument independently", () => {
    const findings = checkArguments(vpc(), {
      cidr: "10.0.0.0/16",
      nope: "x",
      azs: "a bare string",
    });

    expect(findings.map((f) => f.kind).sort()).toEqual([
      "type-mismatch",
      "unknown-argument",
    ]);
  });
});

describe("missingRequiredInputs", () => {
  it("names a required input that is unset, with its type", () => {
    const [finding] = missingRequiredInputs(vpc(), {});

    expect(finding?.kind).toBe("missing-input");
    expect(finding?.subject).toBe("name");
    expect(finding?.message).toContain("(string)");
  });

  it("carries the input's description, which says what to put there", () => {
    const block = vpc({
      inputs: [
        {
          name: "name",
          type: "string",
          required: true,
          description: "The name to give the VPC.",
        },
      ],
    });

    expect(missingRequiredInputs(block, {})[0]?.message).toContain(
      "The name to give the VPC.",
    );
  });

  it("is silent once it is set", () => {
    expect(missingRequiredInputs(vpc(), { name: "demo" })).toEqual([]);
  });

  it("appends the caller's candidate sources when it has any", () => {
    // The dashboard can see the canvas and knows what would fit; a proposed stack
    // cannot, which is why this is a callback rather than a second function.
    const [finding] = missingRequiredInputs(
      vpc(),
      {},
      {
        suggestionsFor: () => ["other.name", "local.prefix"],
      },
    );

    expect(finding?.message).toContain(
      "could come from other.name or local.prefix",
    );
  });

  it("ignores optional inputs", () => {
    expect(
      missingRequiredInputs(vpc(), {}).map((f) => f.subject),
    ).not.toContain("cidr");
  });
});

describe("checkReferences", () => {
  const blocks = new Map<string, BlockInterface>([
    ["network", vpc()],
    ["db", { label: "db", inputs: [], outputs: [{ name: "endpoint" }] }],
  ]);

  it("passes a reference to a block that exists and an output it has", () => {
    expect(
      checkReferences("lb.subnets", "module.network.private_subnets", blocks),
    ).toEqual([]);
  });

  it("reports a reference to a block that is not there", () => {
    const [finding] = checkReferences(
      "lb.vpc_id",
      "module.netwrk.vpc_id",
      blocks,
    );

    expect(finding?.kind).toBe("dangling-module");
    expect(finding?.message).toContain('did you mean "network"');
  });

  it("reports an output the block does not expose, and lists the real ones", () => {
    const [finding] = checkReferences(
      "lb.subnets",
      "module.network.subnets",
      blocks,
    );

    expect(finding?.kind).toBe("unknown-output");
    expect(finding?.confidence).toBe("certain");
    // A suggestion often misses here, so the message names what actually exists.
    expect(finding?.message).toContain("vpc_id, private_subnets");
  });

  it("finds several references in one expression", () => {
    const findings = checkReferences(
      "lb.tags",
      'merge(module.ghost.tags, module.network.nope, "x")',
      blocks,
    );

    expect(findings.map((f) => f.kind)).toEqual([
      "dangling-module",
      "unknown-output",
    ]);
  });

  it("accepts a bare module reference with no output", () => {
    // `module.network` alone is legal in a `depends_on`, and there is no output to check.
    expect(checkReferences("x.y", "module.network", blocks)).toEqual([]);
  });

  it("says nothing about the outputs of a block it cannot describe", () => {
    const opaque = new Map<string, BlockInterface>([
      [
        "hand_written",
        {
          label: "hand_written",
          inputs: [],
          outputs: [],
          knowledge: "unknown",
        },
      ],
    ]);

    expect(
      checkReferences("x.y", "module.hand_written.whatever", opaque),
    ).toEqual([]);
  });

  it("marks an output as unverifiable when the outputs were truncated", () => {
    const partial = new Map<string, BlockInterface>([
      [
        "network",
        vpc({
          knowledge: "partial",
          source: "terrablox/terrablox-aws-vpc at v6.6.1",
          omitted: { outputs: 79 },
        }),
      ],
    ]);

    const [finding] = checkReferences(
      "lb.subnets",
      "module.network.public_subnets",
      partial,
    );

    expect(finding?.kind).toBe("unknown-output");
    expect(finding?.confidence).toBe("unverifiable");
    expect(finding?.message).toContain("79 more were omitted");
  });

  it("attributes the finding to the block that holds the expression", () => {
    // `where` is the argument being read; `ownLabel` is the block it belongs to, which
    // is what a caller grouping findings by block needs.
    const [finding] = checkReferences("lb.vpc_id", "module.ghost.id", blocks, {
      ownLabel: "lb",
    });

    expect(finding?.where).toBe("lb");
  });
});
