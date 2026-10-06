import { describe, expect, it, vi } from "vitest";

// Both mocked because this module builds a Prisma client and a cipher at import time.
// What is under test is the validation in front of them, which is pure.
vi.mock("@terrablox/database", () => ({ prisma: {} }));
vi.mock("@/lib/crypto/secret-box", () => ({
  encryptSecret: (v: string) => v,
  decryptSecret: (v: string) => v,
}));

import {
  APP_REPO_FILE_CHARS_MAX,
  APP_REPO_FILE_CHARS_MIN,
  APP_REPO_READS_MAX,
  APP_REPO_READS_MIN,
  APP_REPO_TREE_MAX,
  APP_REPO_TREE_MIN,
  HISTORY_BUDGET_MAX_CHARS,
  HISTORY_BUDGET_MIN_CHARS,
  MCP_CALL_BUDGET_MAX,
  MCP_CALL_BUDGET_MIN,
  STEP_TRAIL_MAX,
  STEP_TRAIL_MIN,
  TOOL_CALL_BUDGET_MAX,
  TOOL_CALL_BUDGET_MIN,
  TURN_TIMEOUT_MAX_SECONDS,
  TURN_TIMEOUT_MIN_SECONDS,
} from "@terrablox/agent-harness/runtime-options";
import {
  AgentSettingsError,
  asAppRepoFileChars,
  asAppRepoReads,
  asAppRepoTreeLimit,
  asHistoryBudget,
  asMcpCallBudget,
  asReasoningEffort,
  asStepTrailSize,
  asToolCallBudget,
  asTurnTimeout,
} from "./settings-service";

/**
 * The validation in front of the agent settings.
 *
 * Everything here rejects rather than clamps, and that is the property worth pinning
 * down. A clamp stores a number nobody chose, and the screen then shows something other
 * than what the turn will enforce — discovered later as a turn stopping early for no
 * visible reason. Rejecting reaches the user as a sentence naming the range.
 *
 * The empty string matters as much as the numbers: it is what a cleared input field
 * sends, and it has to mean "follow the default" rather than zero.
 */

/** Every numeric setting, with the bounds the API accepts for it. */
const CLAMPS: ReadonlyArray<
  [string, (v: unknown) => number | null, number, number]
> = [
  [
    "turn timeout",
    asTurnTimeout,
    TURN_TIMEOUT_MIN_SECONDS,
    TURN_TIMEOUT_MAX_SECONDS,
  ],
  [
    "operation budget",
    asToolCallBudget,
    TOOL_CALL_BUDGET_MIN,
    TOOL_CALL_BUDGET_MAX,
  ],
  [
    "MCP call budget",
    asMcpCallBudget,
    MCP_CALL_BUDGET_MIN,
    MCP_CALL_BUDGET_MAX,
  ],
  [
    "conversation budget",
    asHistoryBudget,
    HISTORY_BUDGET_MIN_CHARS,
    HISTORY_BUDGET_MAX_CHARS,
  ],
  ["step trail", asStepTrailSize, STEP_TRAIL_MIN, STEP_TRAIL_MAX],
  ["app repo reads", asAppRepoReads, APP_REPO_READS_MIN, APP_REPO_READS_MAX],
  [
    "app repo listing",
    asAppRepoTreeLimit,
    APP_REPO_TREE_MIN,
    APP_REPO_TREE_MAX,
  ],
  [
    "app repo file",
    asAppRepoFileChars,
    APP_REPO_FILE_CHARS_MIN,
    APP_REPO_FILE_CHARS_MAX,
  ],
];

describe.each(CLAMPS)("%s", (name, parse, min, max) => {
  it("treats an empty field, a null and an absent value as the default", () => {
    // All three arrive from the UI for the same gesture: clearing the input.
    for (const empty of ["", null, undefined]) {
      expect(parse(empty), JSON.stringify(empty)).toBeNull();
    }
  });

  it("accepts both ends of its range", () => {
    expect(parse(min)).toBe(min);
    expect(parse(max)).toBe(max);
  });

  it("accepts the string a form sends", () => {
    expect(parse(String(min))).toBe(min);
  });

  it("rounds rather than truncating", () => {
    const value = Math.min(min + 0.6, max);
    expect(parse(value)).toBe(Math.round(value));
  });

  it("rejects below the floor, and names the range", () => {
    expect(() => parse(min - 1)).toThrow(AgentSettingsError);
    expect(() => parse(min - 1)).toThrow(new RegExp(`${min}.*${max}`));
  });

  it("rejects above the ceiling", () => {
    expect(() => parse(max + 1)).toThrow(AgentSettingsError);
  });

  it.each([
    "many",
    Number.NaN,
    Number.POSITIVE_INFINITY,
    {},
  ])(`rejects %o rather than storing something ${name} cannot mean`, (junk) => {
    expect(() => parse(junk)).toThrow(AgentSettingsError);
  });
});

describe("asReasoningEffort", () => {
  it("accepts a level the SDK defines", () => {
    expect(asReasoningEffort("high")).toBe("high");
  });

  it("reads anything else as 'let the model decide'", () => {
    // Null is a real value here: it leaves the model's own default in place.
    for (const value of ["extreme", "", null, undefined]) {
      expect(asReasoningEffort(value), String(value)).toBeNull();
    }
  });
});
