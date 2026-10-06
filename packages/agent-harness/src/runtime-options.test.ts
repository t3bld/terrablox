import { describe, expect, it } from "vitest";

import {
  AGENT_APP_REPO_FILE_CHARS,
  AGENT_APP_REPO_TREE_LIMIT,
  AGENT_HISTORY_BUDGET_CHARS,
  AGENT_MAX_APP_REPO_READS,
  AGENT_MAX_MCP_CALLS,
  AGENT_MAX_STEPS,
  AGENT_MAX_TOOL_CALLS,
  APP_REPO_FILE_CHARS_MAX,
  APP_REPO_FILE_CHARS_MIN,
  APP_REPO_READS_MAX,
  APP_REPO_READS_MIN,
  APP_REPO_TREE_MAX,
  APP_REPO_TREE_MIN,
  DEFAULT_OPERATING_RULES,
  DEFAULT_TURN_TIMEOUT_SECONDS,
  HISTORY_BUDGET_MAX_CHARS,
  HISTORY_BUDGET_MIN_CHARS,
  MCP_CALL_BUDGET_MAX,
  MCP_CALL_BUDGET_MIN,
  maxThoughtsFor,
  renderOperatingRule,
  STEP_TRAIL_MAX,
  STEP_TRAIL_MIN,
  TOOL_CALL_BUDGET_MAX,
  TOOL_CALL_BUDGET_MIN,
  TURN_TIMEOUT_MAX_SECONDS,
  TURN_TIMEOUT_MIN_SECONDS,
} from "./runtime-options";

/**
 * The numbers a turn runs under.
 *
 * Constants are not usually worth a test, but these are eight settings whose values
 * have to agree with each other, and they have already drifted once: the recorded
 * trail sat at 40 entries while the operation budget was raised to 100, so a turn
 * that spent its budget truncated its own record at a quarter and read back as
 * having done far less than it did. Nothing caught that, because each number was
 * defensible alone.
 */

/** Every dial, as the settings screen offers it: floor, default, ceiling. */
const DIALS: ReadonlyArray<[string, number, number, number]> = [
  [
    "turn timeout",
    TURN_TIMEOUT_MIN_SECONDS,
    DEFAULT_TURN_TIMEOUT_SECONDS,
    TURN_TIMEOUT_MAX_SECONDS,
  ],
  [
    "operation budget",
    TOOL_CALL_BUDGET_MIN,
    AGENT_MAX_TOOL_CALLS,
    TOOL_CALL_BUDGET_MAX,
  ],
  [
    "MCP call budget",
    MCP_CALL_BUDGET_MIN,
    AGENT_MAX_MCP_CALLS,
    MCP_CALL_BUDGET_MAX,
  ],
  [
    "conversation budget",
    HISTORY_BUDGET_MIN_CHARS,
    AGENT_HISTORY_BUDGET_CHARS,
    HISTORY_BUDGET_MAX_CHARS,
  ],
  ["step trail", STEP_TRAIL_MIN, AGENT_MAX_STEPS, STEP_TRAIL_MAX],
  [
    "app repo reads",
    APP_REPO_READS_MIN,
    AGENT_MAX_APP_REPO_READS,
    APP_REPO_READS_MAX,
  ],
  [
    "app repo listing",
    APP_REPO_TREE_MIN,
    AGENT_APP_REPO_TREE_LIMIT,
    APP_REPO_TREE_MAX,
  ],
  [
    "app repo file",
    APP_REPO_FILE_CHARS_MIN,
    AGENT_APP_REPO_FILE_CHARS,
    APP_REPO_FILE_CHARS_MAX,
  ],
];

describe("the per-turn dials", () => {
  it.each(DIALS)("%s: floor <= default <= ceiling", (_name, min, def, max) => {
    expect(min).toBeLessThan(max);
    expect(def).toBeGreaterThanOrEqual(min);
    expect(def).toBeLessThanOrEqual(max);
  });

  it("records enough entries for a turn that spends every budget", () => {
    // The drift this file exists to prevent. Operations and MCP calls each produce an
    // entry, and so does every repository read; if the trail cannot hold them, the
    // record of the busiest turns is the one that gets cut.
    const worstCase =
      AGENT_MAX_TOOL_CALLS + AGENT_MAX_MCP_CALLS + AGENT_MAX_APP_REPO_READS;

    expect(worstCase).toBeLessThanOrEqual(AGENT_MAX_STEPS);
  });
});

describe("maxThoughtsFor", () => {
  it("leaves room for the operations, whatever the trail is sized to", () => {
    // A thought is the model narrating; a tool entry is the audit record of a change
    // that reached the repository. Only the second has to survive, so narration can
    // never be allowed to fill the trail.
    for (const size of [
      STEP_TRAIL_MIN,
      100,
      240,
      AGENT_MAX_STEPS,
      1000,
      STEP_TRAIL_MAX,
    ]) {
      expect(maxThoughtsFor(size)).toBeLessThan(size);
      expect(maxThoughtsFor(size)).toBeGreaterThan(0);
    }
  });

  it("reproduces the pair that was hard-coded before it was derived", () => {
    // 120 of 500. Derived rather than stored so the two cannot be set to contradict
    // each other — 300 thoughts in a 100-entry trail was previously expressible.
    expect(maxThoughtsFor(AGENT_MAX_STEPS)).toBe(120);
  });

  it("grows with the trail rather than in steps", () => {
    expect(maxThoughtsFor(1000)).toBeGreaterThan(maxThoughtsFor(500));
  });
});

describe("renderOperatingRule", () => {
  it("substitutes the budget the turn will really enforce", () => {
    // A rule quoting 25 operations, sent to somebody who lowered the budget to 5,
    // would be the prompt lying about what the code allows.
    expect(renderOperatingRule("queue at most {maxToolCalls} of them", 5)).toBe(
      "queue at most 5 of them",
    );
  });

  it("falls back to the default, which is right for the admin preview", () => {
    expect(renderOperatingRule("{maxToolCalls}")).toBe(
      String(AGENT_MAX_TOOL_CALLS),
    );
  });

  it("leaves a rule without the placeholder alone", () => {
    expect(renderOperatingRule("Keep replies short.", 5)).toBe(
      "Keep replies short.",
    );
  });

  it("renders every shipped rule without leaving a placeholder behind", () => {
    for (const rule of DEFAULT_OPERATING_RULES) {
      expect(renderOperatingRule(rule, 7)).not.toMatch(/\{maxToolCalls\}/);
    }
  });
});
