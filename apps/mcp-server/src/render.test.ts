import { describe, expect, it } from "vitest";

import { renderStack } from "./render.js";

describe("renderStack", () => {
  it("pins the source to the tag the catalogue names", () => {
    const hcl = renderStack({
      calls: [
        {
          module: "acm",
          name: "cert",
          arguments: { domain_name: "example.com" },
        },
      ],
    });

    // The version never comes from the caller: an unpinned source is a configuration whose
    // meaning changes when upstream releases, which is the failure the library exists to
    // avoid.
    expect(hcl).toMatch(
      /source\s+= "git::https:\/\/github\.com\/[^"]+\.git\?ref=v[\d.]+"/,
    );
  });

  it("quotes a bare string and leaves an expression alone", () => {
    const hcl = renderStack({
      calls: [
        { module: "vpc", name: "network" },
        {
          module: "acm",
          name: "cert",
          arguments: {
            domain_name: "example.com",
            zone_id: "module.network.zone",
            validation_method: '"DNS"',
          },
        },
      ],
    });

    // `domain_name = example.com` parses as a reference to a variable nobody declared.
    expect(hcl).toContain('domain_name       = "example.com"');
    expect(hcl).toContain("zone_id           = module.network.zone");
    // Already an expression: passed through rather than double-quoted.
    expect(hcl).toContain('validation_method = "DNS"');
    expect(hcl).not.toContain('"\\"DNS\\""');
  });

  it("skips a call whose module is not in the catalogue", () => {
    // `check_stack` reports it; rendering must not invent a source for it.
    const hcl = renderStack({
      calls: [{ module: "not-a-module", name: "ghost" }],
    });
    expect(hcl).toBe("");
  });

  it("renders one block per call", () => {
    const hcl = renderStack({
      calls: [
        { module: "vpc", name: "network" },
        {
          module: "acm",
          name: "cert",
          arguments: { domain_name: "a.example" },
        },
      ],
    });

    expect(hcl.match(/^module /gm)).toHaveLength(2);
  });
});
