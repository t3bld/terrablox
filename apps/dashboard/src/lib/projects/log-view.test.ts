import { describe, expect, it } from "vitest";

import { filterGroups, toGroups } from "./log-view";
import type { AgentStep, ProjectLogTurnDto } from "./types";

/**
 * Grouping the log by turn, and searching across it.
 *
 * The Logs panel shows one line per turn and unfolds on demand, so this decides what a
 * reader sees: which turn a line belongs to, what its number is, and whether a search
 * can reach inside something collapsed. The last of those is where the bug was — the
 * prompt is itself one of a turn's lines, so a prompt match always matched at least
 * that line, which meant the "keep the whole turn" branch was unreachable and
 * searching for a question hid the answer to it.
 */

const thought = (text: string): AgentStep => ({ kind: "thought", text });
const call = (tool: string, summary: string, ok = true): AgentStep => ({
  kind: "tool",
  tool,
  summary,
  ok,
});

const turn = (over: Partial<ProjectLogTurnDto>): ProjectLogTurnDto => ({
  chatMessageId: "m",
  prompt: "add a database",
  reply: "Added it.",
  createdAt: "2026-09-01T10:00:00.000Z",
  steps: [],
  commits: [],
  decisionId: null,
  operations: [],
  ...over,
});

const operation = (summary: string) => ({
  id: `op-${summary}`,
  origin: "agent" as const,
  action: "add-module",
  summary,
  commitSha: "abc1234",
  parentSha: null,
  createdAt: "2026-09-01T10:00:00.000Z",
});

/** Newest first, which is the order the API returns and the panel shows. */
const LOG: ProjectLogTurnDto[] = [
  turn({
    chatMessageId: "m3",
    prompt: "and a cache",
    createdAt: "2026-09-01T12:00:00.000Z",
    steps: [
      thought("Redis fits"),
      call("add_module", "Added redis"),
      call("review_project", "One problem", false),
    ],
    operations: [operation("redis")],
  }),
  // A canvas gesture: an operation with no turn behind it.
  turn({
    chatMessageId: null,
    prompt: null,
    reply: null,
    createdAt: "2026-09-01T11:30:00.000Z",
    operations: [operation("vpc -> rds")],
  }),
  turn({
    chatMessageId: "m2",
    createdAt: "2026-09-01T11:00:00.000Z",
    steps: [thought("Postgres"), call("add_module", "Added rds")],
    decisionId: "d1",
  }),
  turn({
    chatMessageId: "m1",
    prompt: "set up a vpc",
    createdAt: "2026-09-01T10:00:00.000Z",
  }),
];

describe("toGroups", () => {
  const groups = toGroups(LOG);

  it("keeps one group per turn, in the order it was given them", () => {
    expect(groups).toHaveLength(4);
  });

  it("numbers turns from the oldest, so a number survives newer turns arriving", () => {
    expect(groups.map((g) => g.label ?? "canvas")).toEqual([
      "Turn 3",
      "canvas",
      "Turn 2",
      "Turn 1",
    ]);
  });

  it("reads a turn forwards: the prompt, the work, then the answer", () => {
    expect(groups[0]?.rows.map((r) => r.kind)).toEqual([
      "prompt",
      "thought",
      "tool",
      "tool",
      "reply",
    ]);
    expect(groups[0]?.rows.map((r) => r.badge)).toEqual([
      "user",
      "thought",
      "add_module",
      "review_project",
      "reply",
    ]);
  });

  it("counts calls and thoughts apart, for the collapsed header", () => {
    expect([groups[0]?.calls, groups[0]?.thoughts]).toEqual([2, 1]);
  });

  it("surfaces a failed step without the turn having to be unfolded", () => {
    expect(groups[0]?.failed).toBe(true);
    expect(groups[2]?.failed).toBe(false);
  });

  it("treats a canvas gesture as one line with nothing to unfold", () => {
    const canvas = groups[1];
    expect(canvas?.canvas).toBe(true);
    expect(canvas?.rows).toHaveLength(1);
    expect(canvas?.rows[0]?.line).toBe("vpc -> rds");
    expect(canvas?.label).toBeUndefined();
  });

  it("still gives a turn with no steps its prompt and its reply", () => {
    expect(groups[3]?.rows).toHaveLength(2);
  });

  it("gives every row and group a unique id, so selection cannot collide", () => {
    const ids = groups.flatMap((g) => g.rows.map((r) => r.id));
    expect(new Set(ids).size).toBe(ids.length);

    const keys = groups.map((g) => g.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("filterGroups", () => {
  const groups = toGroups(LOG);

  it("returns the same array when there is nothing to filter by", () => {
    expect(filterGroups(groups, "")).toBe(groups);
    expect(filterGroups(groups, "   ")).toBe(groups);
  });

  it("reaches inside a collapsed turn and keeps only what matched", () => {
    const hits = filterGroups(groups, "redis");
    expect(hits).toHaveLength(1);
    // Both lines contain it: the thought and the call.
    expect(hits[0]?.rows.map((r) => r.line)).toEqual([
      "Redis fits",
      "Added redis",
    ]);
  });

  it("keeps a whole turn when its prompt is what matched", () => {
    // The bug. The prompt is also a row, so a prompt match always matched that row
    // too — and the turn was reduced to the line that merely repeats the question,
    // hiding the work that answered it.
    const hits = filterGroups(groups, "add a database");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.label).toBe("Turn 2");
    expect(hits[0]?.rows.map((r) => r.kind)).toEqual([
      "prompt",
      "thought",
      "tool",
      "reply",
    ]);
  });

  it("searches tool names as well as text", () => {
    expect(filterGroups(groups, "add_module").map((g) => g.label)).toEqual([
      "Turn 3",
      "Turn 2",
    ]);
  });

  it("ignores case", () => {
    expect(filterGroups(groups, "REDIS")).toHaveLength(1);
  });

  it("drops a turn entirely rather than leaving it empty", () => {
    expect(filterGroups(groups, "kubernetes")).toEqual([]);
  });

  it("leaves the groups it was given untouched", () => {
    const before = JSON.stringify(groups);
    filterGroups(groups, "redis");
    expect(JSON.stringify(groups)).toBe(before);
  });
});
