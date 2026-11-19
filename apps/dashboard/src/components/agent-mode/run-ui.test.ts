import { describe, expect, it } from "vitest";
import { AGENT_RUN_PHASES, type AgentRunTaskDto } from "@/lib/agent-runs/types";
import { phaseTrack } from "./run-ui";

const task = (
  key: string,
  phase: AgentRunTaskDto["phase"],
  status: AgentRunTaskDto["status"],
  position: number,
): AgentRunTaskDto => ({
  id: key,
  key,
  position,
  phase,
  title: key,
  detail: "",
  dependsOn: [],
  status,
  attempts: 0,
  summary: null,
  startedAt: null,
  finishedAt: null,
});

const states = (track: ReturnType<typeof phaseTrack>) =>
  Object.fromEntries(track.map((step) => [step.key, step.state]));

describe("phaseTrack", () => {
  it("is all upcoming without a run", () => {
    expect(
      phaseTrack(AGENT_RUN_PHASES, null).every((s) => s.state === "upcoming"),
    ).toBe(true);
  });

  it("puts a planning run on the plan step", () => {
    expect(
      states(phaseTrack(AGENT_RUN_PHASES, { status: "planning", tasks: [] }))
        .plan,
    ).toBe("current");
  });

  it("waits on the plan step for approval", () => {
    const track = states(
      phaseTrack(AGENT_RUN_PHASES, {
        status: "awaiting_approval",
        tasks: [task("a", "discover", "pending", 0)],
      }),
    );
    expect(track.plan).toBe("waiting");
    expect(track.discover).toBe("upcoming");
    expect(track.assess).toBe("skipped");
  });

  it("marks finished phases and the one in progress", () => {
    const track = states(
      phaseTrack(AGENT_RUN_PHASES, {
        status: "running",
        tasks: [
          task("a", "discover", "done", 0),
          task("b", "build", "in_progress", 1),
          task("c", "verify", "pending", 2),
        ],
      }),
    );
    expect(track).toMatchObject({
      plan: "done",
      discover: "done",
      assess: "skipped",
      build: "current",
      verify: "upcoming",
    });
  });

  it("shows where a paused run stopped", () => {
    const track = states(
      phaseTrack(AGENT_RUN_PHASES, {
        status: "paused",
        tasks: [task("a", "design", "pending", 0)],
      }),
    );
    expect(track.design).toBe("waiting");
  });
});
