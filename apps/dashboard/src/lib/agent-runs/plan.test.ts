import { describe, expect, it } from "vitest";
import {
  MAX_PLAN_TASKS,
  nextStep,
  type SchedulableTask,
  validatePlan,
} from "./plan";

const task = (key: string, phase: string, dependsOn: string[] = []) => ({
  key,
  phase,
  title: `Task ${key}`,
  detail: "",
  dependsOn,
});

describe("validatePlan", () => {
  it("accepts a plan and orders it by phase", () => {
    const result = validatePlan({
      summary: "Move the app to ECS",
      assumptions: ["Postgres stays Postgres", 3],
      tasks: [
        task("build-net", "build", ["read-app"]),
        task("read-app", "discover"),
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.tasks.map((t) => t.key)).toEqual([
      "read-app",
      "build-net",
    ]);
    expect(result.plan.assumptions).toEqual(["Postgres stays Postgres"]);
  });

  it("rejects unknown phases, duplicate keys and missing dependencies", () => {
    expect(
      validatePlan({ summary: "x", tasks: [task("a", "deploy")] }).ok,
    ).toBe(false);
    expect(
      validatePlan({
        summary: "x",
        tasks: [task("a", "build"), task("a", "build")],
      }).ok,
    ).toBe(false);
    expect(
      validatePlan({ summary: "x", tasks: [task("a", "build", ["b"])] }).ok,
    ).toBe(false);
  });

  it("rejects cycles", () => {
    const result = validatePlan({
      summary: "x",
      tasks: [task("a", "build", ["b"]), task("b", "build", ["a"])],
    });
    expect(result).toEqual({
      ok: false,
      error: "The task dependencies form a cycle.",
    });
  });

  it("rejects plans that are too long or empty", () => {
    const many = Array.from({ length: MAX_PLAN_TASKS + 1 }, (_, i) =>
      task(`t${i}`, "build"),
    );
    expect(validatePlan({ summary: "x", tasks: many }).ok).toBe(false);
    expect(validatePlan({ summary: "x", tasks: [] }).ok).toBe(false);
    expect(validatePlan({ tasks: [task("a", "build")] }).ok).toBe(false);
  });
});

describe("nextStep", () => {
  const t = (
    key: string,
    position: number,
    status: SchedulableTask["status"],
    dependsOn: string[] = [],
  ): SchedulableTask => ({ key, position, status, dependsOn });

  it("picks the first pending task whose dependencies are finished", () => {
    const step = nextStep([
      t("a", 0, "done"),
      t("c", 2, "pending", ["b"]),
      t("b", 1, "pending", ["a"]),
    ]);
    expect(step.kind === "task" && step.task.key).toBe("b");
  });

  it("resumes a task left in progress", () => {
    const step = nextStep([t("a", 0, "in_progress")]);
    expect(step.kind === "task" && step.task.key).toBe("a");
  });

  it("reports done when nothing is open", () => {
    expect(nextStep([t("a", 0, "done"), t("b", 1, "failed")]).kind).toBe(
      "done",
    );
  });

  it("reports blocked when open tasks wait on a failed one", () => {
    const step = nextStep([t("a", 0, "failed"), t("b", 1, "pending", ["a"])]);
    expect(step.kind).toBe("blocked");
    expect(step.kind === "blocked" && step.failed.map((f) => f.key)).toEqual([
      "a",
    ]);
  });
});
