import { describe, expect, it } from "vitest";

import { GraphProjection } from "@/lib/agent/graph-projection";
import type { AgentLibraryModule } from "@/lib/agent/library-view";
import type { ProjectGraph, ProjectGraphNode } from "@/lib/projects/types";

/**
 * The projection's own findings, which had no test at all.
 *
 * Written when the interface check underneath it moved into
 * `@terrablox/terraform/module-interface` — the check existed here in full and in the MCP
 * server in full, and merging them meant editing the one part of the agent path nothing
 * covered. These lock down what the agent is told about its own queued edits, which is the
 * only thing standing between a misremembered port name and a commit.
 *
 * Deliberately narrow: `gaps()`, `unwiredInputs()` and the locals analysis are the
 * projection's own and were not touched, so they are exercised only where they intersect
 * with what changed.
 */

const port = (
  name: string,
  type: string | null = "string",
  required = false,
) => ({
  name,
  type,
  description: null,
  required,
});

const moduleNode = (
  over: Partial<ProjectGraphNode> & { id: string },
): ProjectGraphNode => ({
  label: over.id,
  kind: "module",
  expression: null,
  source: "./modules/x",
  version: null,
  sourceKind: "local",
  file: "main.tf",
  moduleId: null,
  moduleName: null,
  exactVersion: true,
  inputs: [],
  outputs: [],
  values: {},
  // Both required on the real type and both irrelevant here: `setArguments` is what the
  // canvas reads to show which ports are wired, `position` is where it draws the box.
  // Derived from `values` so a fixture cannot describe a block that sets an argument the
  // canvas would not show.
  setArguments: Object.keys(over.values ?? {}),
  position: null,
  ...over,
});

const graphOf = (nodes: ProjectGraphNode[]): ProjectGraph => ({
  nodes,
  edges: [],
  gaps: [],
  resourceCount: 0,
  files: ["main.tf"],
  sha: "abc",
  errors: [],
});

/**
 * A library entry, which is what gives a placed block a *known* interface.
 *
 * Inputs may be named `"azs:list(string)"` to carry a type. It matters which side of the
 * fixture declares it: `fromGraphNode` prefers the library's copy of a port over the
 * node's, because the library is where the declared type and the default live. A test that
 * typed the node and not the library was checking a `string` it thought was a list.
 */
const library = (
  id: string,
  inputs: string[],
  outputs: string[],
): AgentLibraryModule => ({
  id,
  name: id,
  versionTag: "v1",
  description: null,
  tags: [],
  inputs: inputs.map((spec) => {
    const [name, type] = spec.split(":");
    return port(name ?? spec, type ?? "string");
  }),
  outputs: outputs.map((name) => port(name)),
});

function problemsOf(graph: ProjectGraph, lib: AgentLibraryModule[] = []) {
  return new GraphProjection(graph, lib).problems();
}

describe("GraphProjection.problems", () => {
  it("is silent about a block whose arguments all exist", () => {
    const problems = problemsOf(
      graphOf([
        moduleNode({
          id: "network",
          moduleId: "vpc",
          inputs: [port("cidr")],
          values: { cidr: "10.0.0.0/16" },
        }),
      ]),
      [library("vpc", ["cidr"], ["vpc_id"])],
    );

    expect(problems.filter((p) => p.kind === "unknown-argument")).toEqual([]);
    expect(problems.filter((p) => p.kind === "type-mismatch")).toEqual([]);
  });

  it("reports an argument the module does not declare, with a suggestion", () => {
    const problems = problemsOf(
      graphOf([
        moduleNode({
          id: "network",
          moduleId: "vpc",
          inputs: [port("cidr")],
          values: { cidrr: "10.0.0.0/16" },
        }),
      ]),
      [library("vpc", ["cidr"], ["vpc_id"])],
    );

    const found = problems.find((p) => p.kind === "unknown-argument");
    expect(found?.severity).toBe("blocking");
    expect(found?.message).toContain('did you mean "cidr"');
  });

  it("stands down entirely for a block whose ports are unknown", () => {
    // A `module` block written by hand against a source nobody imported. Complaining
    // about its arguments would be inventing findings.
    const problems = problemsOf(
      graphOf([
        moduleNode({ id: "handwritten", values: { anything: "at all" } }),
      ]),
    );

    expect(problems.filter((p) => p.kind === "unknown-argument")).toEqual([]);
  });

  it("catches a bare string given to a list input", () => {
    // The gap the extraction closed. This side used to type-check the raw value, so
    // `production` read as an expression whose shape nothing judges and passed — while
    // `edit_module`'s own pre-check, which coerced first, caught it. Two answers to the
    // same question from one codebase.
    const problems = problemsOf(
      graphOf([
        moduleNode({
          id: "network",
          moduleId: "vpc",
          inputs: [port("azs", "list(string)")],
          values: { azs: "production" },
        }),
      ]),
      [library("vpc", ["azs:list(string)"], [])],
    );

    expect(problems.find((p) => p.kind === "type-mismatch")?.message).toContain(
      "network.azs",
    );
  });

  it("leaves a real expression alone", () => {
    const problems = problemsOf(
      graphOf([
        moduleNode({
          id: "lb",
          moduleId: "elb",
          inputs: [port("subnets", "list(string)")],
          values: { subnets: "module.network.private_subnets" },
        }),
        moduleNode({ id: "network", moduleId: "vpc" }),
      ]),
      [
        library("elb", ["subnets"], []),
        library("vpc", [], ["private_subnets"]),
      ],
    );

    expect(problems.filter((p) => p.kind === "type-mismatch")).toEqual([]);
    expect(problems.filter((p) => p.kind === "unknown-output")).toEqual([]);
  });

  it("reports a reference to a block that is not there", () => {
    const problems = problemsOf(
      graphOf([
        moduleNode({
          id: "lb",
          moduleId: "elb",
          inputs: [port("subnets")],
          values: { subnets: "module.netwrk.private_subnets" },
        }),
        moduleNode({ id: "network", moduleId: "vpc" }),
      ]),
      [
        library("elb", ["subnets"], []),
        library("vpc", [], ["private_subnets"]),
      ],
    );

    const found = problems.find((p) => p.kind === "dangling-module");
    expect(found?.severity).toBe("blocking");
    expect(found?.message).toContain('did you mean "network"');
  });

  it("reports an output the producer does not expose, and names the real ones", () => {
    const problems = problemsOf(
      graphOf([
        moduleNode({
          id: "lb",
          moduleId: "elb",
          inputs: [port("subnets")],
          values: { subnets: "module.network.subnets" },
        }),
        moduleNode({ id: "network", moduleId: "vpc" }),
      ]),
      [
        library("elb", ["subnets"], []),
        library("vpc", [], ["vpc_id", "private_subnets"]),
      ],
    );

    const found = problems.find((p) => p.kind === "unknown-output");
    expect(found?.message).toContain("vpc_id, private_subnets");
    // The hint names the tool this side offers, not the MCP server's.
    expect(found?.message).not.toContain("catalogue");
  });

  it("says nothing about the outputs of a producer it cannot describe", () => {
    const problems = problemsOf(
      graphOf([
        moduleNode({
          id: "lb",
          moduleId: "elb",
          inputs: [port("subnets")],
          values: { subnets: "module.handwritten.whatever" },
        }),
        moduleNode({ id: "handwritten" }),
      ]),
      [library("elb", ["subnets"], [])],
    );

    expect(problems.filter((p) => p.kind === "unknown-output")).toEqual([]);
  });

  it("does not chase references inside an argument that cannot exist", () => {
    // The argument is undeclared, so the line cannot be committed at all — a second
    // finding about what its value points at is noise.
    const problems = problemsOf(
      graphOf([
        moduleNode({
          id: "lb",
          moduleId: "elb",
          inputs: [port("subnets")],
          values: { not_a_port: "module.ghost.id" },
        }),
      ]),
      [library("elb", ["subnets"], [])],
    );

    expect(problems.map((p) => p.kind)).toContain("unknown-argument");
    expect(problems.map((p) => p.kind)).not.toContain("dangling-module");
  });

  it("still reports a local that does not exist", () => {
    // The locals half stayed in the projection; this is the check that it survived the
    // move of the module half.
    const problems = problemsOf(
      graphOf([
        moduleNode({
          id: "lb",
          moduleId: "elb",
          inputs: [port("subnets")],
          values: { subnets: "local.missing" },
        }),
      ]),
      [library("elb", ["subnets"], [])],
    );

    expect(
      problems.find((p) => p.kind === "dangling-local")?.message,
    ).toContain("local.missing");
  });

  it("sorts blocking findings before advisory ones", () => {
    const problems = problemsOf(
      graphOf([
        moduleNode({
          id: "lb",
          moduleId: "elb",
          inputs: [port("subnets")],
          values: { nope: "x" },
        }),
        { ...moduleNode({ id: "unused" }), kind: "local", expression: '"x"' },
      ]),
      [library("elb", ["subnets"], [])],
    );

    const severities = problems.map((p) => p.severity);
    expect(severities.indexOf("blocking")).toBeLessThan(
      severities.lastIndexOf("advisory"),
    );
  });
});
