import { describe, expect, it } from "vitest";

import {
  type ArchitectureReference,
  type ArchitectureResource,
  buildArchitecture,
} from "./architecture-graph";

/**
 * The architecture diagram, derived from Terraform.
 *
 * The product's most load-bearing derivation and the one with the least feedback: it
 * turns a set of resource blocks into nested frames, and every mistake it makes looks
 * plausible on screen. Both bugs that reached a real project were of that kind — a tier
 * frame that lost its children, and a per-zone frame duplicated once per availability
 * zone — and both were only caught by running the builder over a real project's
 * resources and counting what came out.
 *
 * These fixtures are that shape: the upstream `terraform-aws-modules/vpc` layout, which
 * is what most projects actually contain.
 */

const resource = (
  resourceType: string,
  resourceName: string | null,
  over: Partial<ArchitectureResource> = {},
): ArchitectureResource => ({
  resourceType,
  resourceName,
  kind: "managed",
  ...over,
});

const ref = (
  fromAddress: string,
  toAddress: string,
  attributes: string[],
): ArchitectureReference => ({ fromAddress, toAddress, attributes });

/** How the VPC module writes a subnet that is spread across the zones. */
const PER_ZONE = "element(var.azs, count.index)";

/** Children of a node, by parent id, for walking the tree the builder produced. */
const childrenOf = (graph: ReturnType<typeof buildArchitecture>, id?: string) =>
  graph.nodes.filter((n) => n.parentId === id);

describe("buildArchitecture", () => {
  describe("containment", () => {
    const graph = buildArchitecture(
      [
        resource("aws_vpc", "this"),
        resource("aws_subnet", "public", { availabilityZone: PER_ZONE }),
        resource("aws_subnet", "private", { availabilityZone: PER_ZONE }),
        resource("aws_nat_gateway", "this"),
        resource("aws_internet_gateway", "this"),
      ],
      [
        ref("aws_subnet.public", "aws_vpc.this", ["vpc_id"]),
        ref("aws_subnet.private", "aws_vpc.this", ["vpc_id"]),
        ref("aws_internet_gateway.this", "aws_vpc.this", ["vpc_id"]),
        ref("aws_nat_gateway.this", "aws_subnet.public", ["subnet_id"]),
      ],
      [],
    );

    it("puts the subnets inside the VPC", () => {
      const vpc = graph.nodes.find((n) => n.type === "vpc");
      expect(vpc).toBeDefined();
      // Matched on the prefix: these subnets carry `availability_zone`, so the
      // builder appends what that says about their multiplicity.
      const inside = childrenOf(graph, vpc?.id).map((n) => n.sublabel ?? "");
      expect(inside.some((s) => s.startsWith("public"))).toBe(true);
      expect(inside.some((s) => s.startsWith("private"))).toBe(true);
    });

    it("puts a NAT gateway inside the subnet it names", () => {
      const publicSubnet = graph.nodes.find((n) =>
        n.sublabel?.startsWith("public"),
      );
      expect(childrenOf(graph, publicSubnet?.id).map((n) => n.label)).toContain(
        "NAT Gateway",
      );
    });

    it("leaves nothing floating outside the VPC that belongs inside it", () => {
      // The regression that emptied four tiers in a real project: everything wired to
      // a tier was re-parented to the VPC, which is where the useful fact was lost.
      const roots = childrenOf(graph, undefined);
      expect(roots.map((n) => n.type)).not.toContain("subnet");
    });

    it("draws every declared resource exactly once", () => {
      // The duplicate-frame bug: a per-zone subnet appeared once per zone even when
      // nothing said how many zones there were.
      const byAddress = new Map<string, number>();
      for (const node of graph.nodes) {
        for (const address of node.addresses ?? []) {
          byAddress.set(address, (byAddress.get(address) ?? 0) + 1);
        }
      }
      expect([...byAddress.entries()].filter(([, n]) => n > 1)).toEqual([]);
    });
  });

  describe("what a spread across zones is reported as", () => {
    /** No caller, no inputs — how a module's own page renders it. */
    const moduleView = buildArchitecture(
      [
        resource("aws_vpc", "this"),
        ...[
          "public",
          "private",
          "database",
          "elasticache",
          "intra",
          "redshift",
        ].map((tier) =>
          resource("aws_subnet", tier, {
            conditionalOn: `\${local.create_${tier}_subnets ? local.len_${tier}_subnets : 0}`,
            availabilityZone: PER_ZONE,
          }),
        ),
        // Pinned to one zone by a variable, not spread over an index.
        resource("aws_subnet", "outpost", {
          availabilityZone: "var.outpost_az",
        }),
      ],
      [
        "public",
        "private",
        "database",
        "elasticache",
        "intra",
        "redshift",
        "outpost",
      ].map((tier) => ref(`aws_subnet.${tier}`, "aws_vpc.this", ["vpc_id"])),
      [],
    );

    const sublabelOf = (tier: string) =>
      moduleView.nodes.find((n) => n.sublabel?.startsWith(tier))?.sublabel;

    it("says so on a subnet written once per zone", () => {
      // Without inputs the count is unknowable, and saying nothing would leave a tier
      // indistinguishable from a single subnet. The expression alone settles the shape.
      expect(sublabelOf("public")).toBe("public · one per availability zone");
    });

    it("says it for every tier, not just the first", () => {
      for (const tier of [
        "public",
        "private",
        "database",
        "elasticache",
        "intra",
        "redshift",
      ]) {
        expect(sublabelOf(tier), tier).toContain("one per availability zone");
      }
    });

    it("stays quiet about a subnet pinned to a named zone", () => {
      // `availability_zone = var.outpost_az` says the opposite of a spread.
      expect(sublabelOf("outpost")).toBe("outpost");
    });

    it("keeps one frame per tier, however many zones there turn out to be", () => {
      const tiers = moduleView.nodes.filter((n) => n.type === "subnet");
      expect(tiers).toHaveLength(7);
    });
  });

  describe("what is left out", () => {
    it("ignores data sources, which describe lookups rather than infrastructure", () => {
      const graph = buildArchitecture(
        [
          resource("aws_vpc", "this"),
          resource("aws_availability_zones", "available", { kind: "data" }),
        ],
        [],
        [],
      );
      expect(
        graph.nodes.some((n) =>
          n.addresses?.includes("aws_availability_zones.available"),
        ),
      ).toBe(false);
    });

    it("returns an empty graph for an empty module rather than throwing", () => {
      expect(buildArchitecture([], [], [])).toEqual(
        expect.objectContaining({ nodes: [], edges: [] }),
      );
    });
  });

  it("names a resource only where the name says something", () => {
    // `this` and `current` are conventions meaning "the only one", so they filled the
    // second line of a tile with a word that told the reader nothing.
    const graph = buildArchitecture([resource("aws_vpc", "this")], [], []);
    expect(graph.nodes[0]?.sublabel).toBeUndefined();
  });
});
