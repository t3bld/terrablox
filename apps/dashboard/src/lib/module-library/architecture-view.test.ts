import { describe, expect, it } from "vitest";

import {
  boxDetail,
  type DiagramBox,
  type DiagramEdge,
  labelFor,
  moduleHrefs,
  type NestedResponse,
  neighboursOf,
  nestedModuleData,
  repositoryUrl,
  resolveAddress,
  toModuleCalls,
} from "./architecture-view";
import type { ModuleDependencyDto, ModuleResourceDto } from "./types";

/**
 * The architecture view's derivations.
 *
 * These were nine `useMemo` bodies inside a client component, so checking any of them
 * meant rendering a canvas and clicking a box. The idea worth pinning down is the call
 * path: the same repository reached through two different module calls is two different
 * boxes, and only the chain of names says which one an address belongs to.
 */

function dependency(
  name: string,
  extra: Partial<ModuleDependencyDto> = {},
): ModuleDependencyDto {
  return {
    name,
    source: `git::https://github.com/acme/terraform-aws-${name}.git`,
    sourceKind: "git",
    linkedModule: null,
    ...extra,
  } as ModuleDependencyDto;
}

function resource(
  resourceType: string,
  resourceName: string,
): ModuleResourceDto {
  return {
    kind: "resource",
    resourceType,
    resourceName,
    providerName: "aws",
    providerUrl: null,
    sourceFile: "main.tf",
    conditionalOn: null,
    resourceUrl: null,
    resourceDescription: null,
  } as ModuleResourceDto;
}

describe("repositoryUrl", () => {
  it("strips a forwarding prefix", () => {
    expect(
      repositoryUrl("git::https://github.com/acme/terraform-aws-vpc.git"),
    ).toBe("https://github.com/acme/terraform-aws-vpc.git");
  });

  it("strips a ref query", () => {
    expect(repositoryUrl("https://github.com/acme/mod.git?ref=v1.2.0")).toBe(
      "https://github.com/acme/mod.git",
    );
  });

  it("stops at a subdirectory, and is not fooled by the scheme's own slashes", () => {
    // The `//` that separates a subdirectory looks exactly like the one in `https://`,
    // so the search has to start after the scheme.
    expect(repositoryUrl("https://github.com/acme/mono.git//modules/vpc")).toBe(
      "https://github.com/acme/mono.git",
    );
  });

  it("handles a prefix, a subdirectory and a ref at once", () => {
    expect(
      repositoryUrl(
        "git::https://github.com/acme/mono.git//modules/vpc?ref=v2",
      ),
    ).toBe("https://github.com/acme/mono.git");
  });

  it("returns null for a registry address, which is not a URL", () => {
    // `terraform-aws-modules/vpc/aws` has no scheme, so there is nowhere to send a
    // reader — and a guessed URL into someone's account is worse than no link.
    expect(repositoryUrl("terraform-aws-modules/vpc/aws")).toBeNull();
  });

  it("returns null for nothing at all", () => {
    expect(repositoryUrl(null)).toBeNull();
    expect(repositoryUrl(undefined)).toBeNull();
    expect(repositoryUrl("   ")).toBeNull();
  });
});

describe("toModuleCalls", () => {
  it("is empty without dependencies", () => {
    expect(toModuleCalls(undefined)).toEqual([]);
  });

  it("drops a call with no source, which cannot be resolved or linked", () => {
    expect(
      toModuleCalls([dependency("vpc"), dependency("ghost", { source: null })]),
    ).toHaveLength(1);
  });

  it("carries requestedRef only when the import is not the ref that was asked for", () => {
    // This is the case the diagram has to be able to mark. A box silently showing a
    // different version is worse than no box.
    const [mismatched] = toModuleCalls([
      dependency("vpc", {
        linkedModule: {
          moduleId: "m1",
          exactVersion: false,
          requestedRef: "v5.1.0",
        },
      } as Partial<ModuleDependencyDto>),
    ]);
    expect(mismatched?.requestedRef).toBe("v5.1.0");

    const [exact] = toModuleCalls([
      dependency("rds", {
        linkedModule: {
          moduleId: "m2",
          exactVersion: true,
          requestedRef: "v6.0.0",
        },
      } as Partial<ModuleDependencyDto>),
    ]);
    expect(exact?.requestedRef).toBeNull();
  });
});

describe("nestedModuleData", () => {
  const nested: NestedResponse = {
    rootId: "root",
    modules: {
      m1: {
        id: "m1",
        name: "terraform-aws-vpc",
        versionTag: "v5.1.0",
        resources: [],
        references: [],
        moduleCalls: [
          {
            name: "inner",
            source: "./inner",
            sourceKind: "local",
            linkedModule: null,
          },
          {
            name: "nosource",
            source: null,
            sourceKind: null,
            linkedModule: null,
          },
        ],
      },
    },
  };

  it("returns null for a call that resolved to nothing", () => {
    expect(
      nestedModuleData({ name: "x", source: "s", sourceKind: null }, nested),
    ).toBeNull();
  });

  it("returns null when the fetched tree does not carry the module", () => {
    expect(
      nestedModuleData(
        { name: "x", source: "s", sourceKind: null, moduleId: "absent" },
        nested,
      ),
    ).toBeNull();
  });

  it("drops sourceless calls at the nested level too", () => {
    const data = nestedModuleData(
      { name: "vpc", source: "s", sourceKind: null, moduleId: "m1" },
      nested,
    );

    expect(data?.name).toBe("terraform-aws-vpc");
    expect(data?.moduleCalls.map((c) => c.name)).toEqual(["inner"]);
  });
});

describe("resolveAddress", () => {
  const nested: NestedResponse = {
    rootId: "root",
    modules: {
      root: {
        id: "root",
        name: "wrapper",
        versionTag: null,
        resources: [],
        references: [],
        moduleCalls: [
          {
            name: "vpc",
            source: "./vpc",
            sourceKind: "local",
            linkedModule: {
              moduleId: "m-vpc",
              exactVersion: true,
              requestedRef: null,
            },
          },
          {
            name: "unlinked",
            source: "./unlinked",
            sourceKind: "local",
            linkedModule: null,
          },
        ],
      },
      "m-vpc": {
        id: "m-vpc",
        name: "terraform-aws-vpc",
        versionTag: "v5.1.0",
        resources: [resource("aws_subnet", "private")],
        references: [],
        moduleCalls: [],
      },
    },
  };

  const context = {
    nested,
    resources: [resource("aws_s3_bucket", "logs")],
    dependencies: [dependency("vpc")],
  };

  it("finds a resource this module declares itself", () => {
    const resolved = resolveAddress("aws_s3_bucket.logs", context);

    expect(resolved.local).toBe("aws_s3_bucket.logs");
    // Nothing in front of the address, so nothing to attribute to another module.
    expect(resolved.fromModule).toBeUndefined();
    expect(resolved.resource?.resourceName).toBe("logs");
  });

  it("walks one level of call path and attributes the box to that module", () => {
    const resolved = resolveAddress("module.vpc/aws_subnet.private", context);

    expect(resolved.local).toBe("aws_subnet.private");
    expect(resolved.fromModule).toBe("terraform-aws-vpc");
    expect(resolved.fromModuleId).toBe("m-vpc");
    expect(resolved.resource?.resourceName).toBe("private");
  });

  it("still yields the local address when the chain cannot be resolved", () => {
    // More useful than refusing to say anything about the box.
    const resolved = resolveAddress(
      "module.unlinked/aws_subnet.private",
      context,
    );

    expect(resolved.local).toBe("aws_subnet.private");
    expect(resolved.fromModule).toBeUndefined();
    expect(resolved.resource).toBeUndefined();
  });

  it("does not attribute a resource from the wrong module", () => {
    // `aws_subnet.private` exists inside m-vpc, not at the root. Looking in the wrong
    // pool is exactly the mistake the call path prevents.
    expect(
      resolveAddress("aws_subnet.private", context).resource,
    ).toBeUndefined();
  });

  it("reports the source of a module-call box at the root", () => {
    const resolved = resolveAddress("module.vpc", context);

    expect(resolved.moduleSource).toContain("terraform-aws-vpc");
    expect(resolved.moduleSourceKind).toBe("git");
  });

  it("copes with no fetched tree at all", () => {
    const resolved = resolveAddress("aws_s3_bucket.logs", {
      nested: null,
      resources: context.resources,
      dependencies: context.dependencies,
    });

    expect(resolved.local).toBe("aws_s3_bucket.logs");
    expect(resolved.resource?.resourceName).toBe("logs");
  });
});

describe("labelFor", () => {
  const boxes = new Map<string, DiagramBox>([
    ["a", { id: "a", label: "Subnet", sublabel: "private", addresses: [] }],
    ["b", { id: "b", label: "Bucket", addresses: [] }],
  ]);

  it("joins label and sublabel", () => {
    expect(labelFor(boxes, "a")).toBe("Subnet · private");
  });

  it("uses the label alone when there is no sublabel", () => {
    expect(labelFor(boxes, "b")).toBe("Bucket");
  });

  it("falls back to the id rather than showing nothing", () => {
    expect(labelFor(boxes, "gone")).toBe("gone");
  });
});

describe("neighboursOf", () => {
  const edges: DiagramEdge[] = [
    { source: "alb", target: "app" },
    { source: "app", target: "db" },
    { source: "app", target: "cache" },
    {
      source: "cdn",
      target: "app",
      via: ["module.x/aws_cloudfront_vpc_origin.o"],
    },
    // A second edge between the same pair, which must not produce a second entry.
    { source: "app", target: "db" },
  ];
  const name = (id: string) => id.toUpperCase();

  it("is empty with nothing selected", () => {
    expect(neighboursOf(edges, null, name)).toEqual({ feeds: [], fedBy: [] });
  });

  it("splits neighbours by direction", () => {
    const { feeds, fedBy } = neighboursOf(edges, "app", name);

    expect(feeds.map((n) => n.address)).toEqual(["cache", "db"]);
    expect(fedBy.map((n) => n.address)).toEqual(["alb", "cdn"]);
  });

  it("lists a pair once even when several edges join it", () => {
    expect(
      neighboursOf(edges, "app", name).feeds.filter((n) => n.address === "db"),
    ).toHaveLength(1);
  });

  it("sorts by the label the reader sees, numerically aware", () => {
    const numbered: DiagramEdge[] = [
      { source: "x", target: "n10" },
      { source: "x", target: "n2" },
    ];

    expect(
      neighboursOf(numbered, "x", (id) => id).feeds.map((n) => n.address),
    ).toEqual(["n2", "n10"]);
  });

  it("explains a routed connection instead of letting it look invented", () => {
    // Nothing in the Terraform says CloudFront points at a load balancer; an
    // `aws_cloudfront_vpc_origin` between them does.
    const cdn = neighboursOf(edges, "app", name).fedBy.find(
      (n) => n.address === "cdn",
    );

    expect(cdn?.note).toBe("via aws_cloudfront_vpc_origin.o");
  });

  it("leaves the note off a direct connection", () => {
    expect(
      neighboursOf(edges, "app", name).fedBy.find((n) => n.address === "alb")
        ?.note,
    ).toBeUndefined();
  });
});

describe("boxDetail", () => {
  const resolve = (address: string) => ({ local: address });

  it("is null with nothing selected", () => {
    expect(boxDetail(null, resolve)).toBeNull();
  });

  it("reports a single-resource box as `only`", () => {
    const detail = boxDetail(
      { id: "a", label: "Bucket", addresses: ["aws_s3_bucket.logs"] },
      resolve,
    );

    expect(detail?.only?.local).toBe("aws_s3_bucket.logs");
    expect(detail?.call).toBeUndefined();
  });

  it("leaves `only` unset when several blocks are drawn as one tile", () => {
    // An HTTP API is five Terraform blocks behind one box. The tile shows "×5"; this
    // is where the reader finds out which five.
    const detail = boxDetail(
      {
        id: "a",
        label: "HTTP API",
        addresses: ["aws_apigatewayv2_api.a", "aws_apigatewayv2_stage.s"],
      },
      resolve,
    );

    expect(detail?.only).toBeUndefined();
    expect(detail?.resources).toHaveLength(2);
  });

  it("separates a module call from the resources folded into it", () => {
    const detail = boxDetail(
      {
        id: "m",
        label: "vpc",
        isModuleCall: true,
        addresses: ["module.vpc", "aws_security_group.extra"],
      },
      resolve,
    );

    expect(detail?.call?.local).toBe("module.vpc");
    expect(detail?.resources.map((r) => r.local)).toEqual([
      "aws_security_group.extra",
    ]);
    // A call is never "one resource", however few things are folded into it.
    expect(detail?.only).toBeUndefined();
  });

  it("keeps each attachment's own fields beside the resolved entries", () => {
    const detail = boxDetail(
      {
        id: "a",
        label: "Lambda",
        addresses: ["aws_lambda_function.f"],
        attachments: [
          {
            service: "IAM",
            icon: "iam",
            addresses: ["aws_iam_role.r"],
            shared: true,
          },
        ],
      },
      resolve,
    );

    expect(detail?.supporting[0]?.service).toBe("IAM");
    expect(detail?.supporting[0]?.shared).toBe(true);
    expect(detail?.supporting[0]?.entries.map((e) => e.local)).toEqual([
      "aws_iam_role.r",
    ]);
  });
});

describe("moduleHrefs", () => {
  it("is empty without dependencies", () => {
    expect(moduleHrefs(undefined).size).toBe(0);
  });

  it("links only the calls that resolved to an imported module", () => {
    // A tile must never promise a page that does not exist.
    const map = moduleHrefs([
      dependency("vpc", {
        linkedModule: {
          moduleId: "m-vpc",
          exactVersion: true,
          requestedRef: null,
        },
      } as Partial<ModuleDependencyDto>),
      dependency("unresolved"),
    ]);

    expect(map.get("module.vpc")).toBe("/modules/m-vpc#architecture");
    expect(map.has("module.unresolved")).toBe(false);
  });
});
