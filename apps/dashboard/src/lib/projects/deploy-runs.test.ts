import { describe, expect, it } from "vitest";
import {
  activeRuns,
  blockerFor,
  isRunFromDispatch,
  type RunnableWorkflow,
} from "./deploy-runs";
import type { WorkflowRunDto } from "./types";

function run(extra: Partial<WorkflowRunDto>): WorkflowRunDto {
  return {
    id: 1,
    name: "Terraform Plan",
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    headBranch: "main",
    htmlUrl: "https://github.com/o/r/actions/runs/1",
    createdAt: "2026-11-17T10:00:00Z",
    ...extra,
  };
}

const plan: RunnableWorkflow = {
  id: "plan",
  name: "Terraform Plan",
  lock: "terraform-state",
};
const apply: RunnableWorkflow = {
  id: "apply",
  name: "Terraform Apply",
  lock: "terraform-state",
};
const lint: RunnableWorkflow = { id: "lint", name: "Lint", lock: null };
const workflows = [plan, apply, lint];

describe("activeRuns", () => {
  it("lists queued and running catalogue runs only", () => {
    const active = activeRuns(
      [
        run({ id: 1, status: "queued" }),
        run({ id: 2, name: "CI", status: "in_progress" }),
        run({ id: 3, name: "Terraform Apply" }),
      ],
      workflows,
    );
    expect(active.map((entry) => entry.run.id)).toEqual([1]);
  });
});

describe("blockerFor", () => {
  it("keeps workflows sharing a lock apart", () => {
    const runs = [run({ name: "Terraform Apply", status: "in_progress" })];
    expect(blockerFor(plan, { runs, workflows })?.kind).toBe("run");
    expect(blockerFor(apply, { runs, workflows })?.kind).toBe("run");
  });

  it("lets a workflow without a lock run alongside", () => {
    const runs = [run({ name: "Terraform Apply", status: "in_progress" })];
    expect(blockerFor(lint, { runs, workflows })).toBeNull();
  });

  it("never runs the same workflow twice at once, lock or not", () => {
    const runs = [run({ name: "Lint", status: "in_progress" })];
    expect(blockerFor(lint, { runs, workflows })?.kind).toBe("run");
    expect(blockerFor(plan, { runs, workflows })).toBeNull();
  });

  it("counts a dispatch GitHub has not listed yet", () => {
    const pending = [{ name: "Terraform Plan", at: Date.now() }];
    expect(blockerFor(apply, { runs: [], workflows, pending })?.kind).toBe(
      "pending",
    );
    expect(blockerFor(lint, { runs: [], workflows, pending })).toBeNull();
  });
});

describe("isRunFromDispatch", () => {
  const at = new Date("2026-11-17T10:00:00Z").getTime();

  it("matches the same workflow created after the click", () => {
    expect(
      isRunFromDispatch(run({ createdAt: "2026-11-17T10:00:05Z" }), {
        name: "Terraform Plan",
        at,
      }),
    ).toBe(true);
  });

  it("does not match an older run or another workflow", () => {
    expect(
      isRunFromDispatch(run({ createdAt: "2026-11-17T09:50:00Z" }), {
        name: "Terraform Plan",
        at,
      }),
    ).toBe(false);
    expect(
      isRunFromDispatch(
        run({ name: "Terraform Apply", createdAt: "2026-11-17T10:00:05Z" }),
        { name: "Terraform Plan", at },
      ),
    ).toBe(false);
  });
});
