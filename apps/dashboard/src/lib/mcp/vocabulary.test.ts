import { isKnownTool } from "@terrablox/agent-harness/tool-catalogue";
import { describe, expect, it } from "vitest";

import { SHARED_VOCABULARY } from "@/lib/mcp/vocabulary";

/**
 * The one vocabulary, checked twice.
 *
 * `SHARED_VOCABULARY` carries a `satisfies` clause, so a tool renamed in the harness
 * already breaks the build — that is the real enforcement and it was verified by renaming
 * `connect` and watching this module stop compiling. This test covers the case the type
 * cannot: a name *removed* from the harness while a string literal here stays valid on its
 * own, which `satisfies` against a union would only catch if the union still lacked it.
 *
 * It is also what makes the constant legitimately used rather than a declaration kept
 * alive by a lint suppression.
 */
describe("the vocabulary shared with the agent harness", () => {
  it("names only operations the harness also has", () => {
    const strangers = SHARED_VOCABULARY.filter((name) => !isKnownTool(name));

    expect(strangers).toEqual([]);
  });

  it("is not empty, so the check cannot pass by describing nothing", () => {
    expect(SHARED_VOCABULARY.length).toBeGreaterThan(5);
  });
});
