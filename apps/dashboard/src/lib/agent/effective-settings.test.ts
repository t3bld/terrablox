import { describe, expect, it, vi } from "vitest";

// Mocked because the module builds a Prisma client at import time. Nothing under test
// here touches the database: `parseOverrides` and `mergeAgentSettings` are the pure
// half of this file, and they are the half where a mistake is silent.
vi.mock("@terrablox/database", () => ({ prisma: {} }));

import {
  APP_REPO_READS_MAX,
  HISTORY_BUDGET_MAX_CHARS,
  STEP_TRAIL_MAX,
  STEP_TRAIL_MIN,
  TOOL_CALL_BUDGET_MAX,
} from "@terrablox/agent-harness/runtime-options";
import {
  type AgentOverrides,
  mergeAgentSettings,
  parseOverrides,
} from "./effective-settings";
import type { AgentSettingsView } from "./settings-service";

/**
 * Per-project agent overrides, read back out of a JSON column.
 *
 * The column is written by us and read by a build that may be older or newer than the
 * one that wrote it, so this is the boundary where a stale value has to stop. The rule
 * it enforces is deliberately blunt: anything outside today's bounds reads as "inherit"
 * rather than as a number, because a 500-operation budget stored before the ceiling
 * existed must not become a 500-operation turn.
 *
 * `undefined` versus `null` carries meaning here and is easy to break: absent means the
 * project has no opinion, null means it deliberately follows the default. Only the
 * first must stay out of the "this project decides it" list.
 */

const GLOBAL: AgentSettingsView = {
  instructions: "",
  disabledKnowledge: [],
  mcpServers: [],
  model: "claude-opus-5",
  reasoningEffort: "high",
  disabledTools: [],
  turnTimeout: 900,
  maxToolCalls: 50,
  maxMcpCalls: 50,
  historyBudgetChars: 12_000,
  maxSteps: 300,
  maxAppRepoReads: 20,
  appRepoTreeLimit: 200,
  appRepoFileChars: 10_000,
  allowDestructive: false,
};

describe("parseOverrides", () => {
  it("keeps a value that is inside today's bounds", () => {
    expect(
      parseOverrides({
        maxSteps: 240,
        maxToolCalls: 10,
        maxAppRepoReads: 12,
        appRepoFileChars: 50_000,
      }),
    ).toEqual({
      maxSteps: 240,
      maxToolCalls: 10,
      maxAppRepoReads: 12,
      appRepoFileChars: 50_000,
    });
  });

  it.each([
    ["maxSteps", STEP_TRAIL_MAX + 1],
    ["maxSteps", STEP_TRAIL_MIN - 1],
    ["maxToolCalls", TOOL_CALL_BUDGET_MAX + 1],
    ["maxToolCalls", 0],
    ["maxAppRepoReads", APP_REPO_READS_MAX + 1],
    ["appRepoFileChars", 10],
    ["historyBudgetChars", HISTORY_BUDGET_MAX_CHARS + 1],
  ])("reads %s=%i as inherit, because it is out of range", (key, value) => {
    expect(parseOverrides({ [key]: value })).toEqual({ [key]: null });
  });

  it.each([
    ["a number as words", "many"],
    ["nothing", null],
    ["a boolean", true],
  ])("reads %s as inherit rather than coercing it", (_what, value) => {
    expect(parseOverrides({ maxSteps: value }).maxSteps).toBeNull();
  });

  it("leaves an absent key absent, so it is not claimed as an override", () => {
    // The distinction the "this project" badge depends on: a stored null is an opinion
    // ("follow the default here"), a missing key is no opinion at all.
    const parsed = parseOverrides({ maxToolCalls: 5 });
    expect("maxSteps" in parsed).toBe(false);
    expect(parsed.maxToolCalls).toBe(5);
  });

  it.each([
    null,
    undefined,
    "text",
    7,
    [],
  ])("returns nothing at all for %o, which is not an override object", (value) => {
    expect(parseOverrides(value)).toEqual({});
  });

  it("drops a tool or knowledge id it no longer recognises", () => {
    // A retired name must stop withholding anything immediately, not once somebody
    // next opens the settings screen.
    const parsed = parseOverrides({
      disabledTools: ["add_module", "a_tool_we_removed"],
      disabledKnowledge: ["not-a-source"],
    });
    expect(parsed.disabledTools).not.toContain("a_tool_we_removed");
    expect(parsed.disabledKnowledge).toEqual([]);
  });

  it("accepts only a real boolean for the permission to delete", () => {
    // Coercing anything unexpected here could only ever err towards granting it.
    expect(parseOverrides({ allowDestructive: true }).allowDestructive).toBe(
      true,
    );
    expect(
      "allowDestructive" in parseOverrides({ allowDestructive: "yes" }),
    ).toBe(false);
  });
});

describe("mergeAgentSettings", () => {
  it("falls through to the global value where the project has no opinion", () => {
    const merged = mergeAgentSettings(GLOBAL, {});
    expect(merged.maxToolCalls).toBe(50);
    expect(merged.maxSteps).toBe(300);
    expect(merged.overridden).toEqual([]);
  });

  it("lets the project win where it has one", () => {
    const merged = mergeAgentSettings(GLOBAL, {
      maxToolCalls: 5,
      maxSteps: 100,
    });
    expect(merged.maxToolCalls).toBe(5);
    expect(merged.maxSteps).toBe(100);
    expect(merged.overridden).toEqual(
      expect.arrayContaining(["maxToolCalls", "maxSteps"]),
    );
  });

  it("respects a project that deliberately switched a permission off", () => {
    // `??` is wrong for a boolean: a project that set `false` would fall through to a
    // global `true` and silently regain the permission it just gave up.
    const merged = mergeAgentSettings(
      { ...GLOBAL, allowDestructive: true },
      { allowDestructive: false },
    );
    expect(merged.allowDestructive).toBe(false);
  });

  it("never lets a project decide which servers are connected", () => {
    // A server is a URL plus one of the owner's credentials. A project that could
    // enable one would be enabling a connection its owner may never have looked at.
    const merged = mergeAgentSettings(GLOBAL, {} as AgentOverrides);
    expect(merged.mcpServers).toBe(GLOBAL.mcpServers);
  });

  it("keeps instructions global, because they are the user's standing preferences", () => {
    const merged = mergeAgentSettings(
      { ...GLOBAL, instructions: "house rules" },
      {},
    );
    expect(merged.instructions).toBe("house rules");
  });
});
