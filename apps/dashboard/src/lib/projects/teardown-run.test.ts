import { describe, expect, it } from "vitest";
import type { TeardownPlan, TeardownProgress } from "./teardown";
import {
  failTeardownRun,
  mergeTeardownProgress,
  retryTeardownRun,
  startTeardownRun,
  teardownChecklist,
} from "./teardown-run";

const plan: TeardownPlan = {
  roleStack: { name: "demo-bootstrap", status: "CREATE_COMPLETE" },
  stateStack: { name: "demo-state", status: "CREATE_COMPLETE" },
  buckets: [
    {
      name: "demo-tfstate-123456789012-abcdef",
      kmsKeyArn: "arn:aws:kms:eu-central-1:123456789012:key/k1",
      orphaned: false,
      trackedResources: 3,
    },
  ],
  keyDeletionDays: 7,
};

function progress(overrides: Partial<TeardownProgress>): TeardownProgress {
  return {
    done: false,
    waitingFor: [],
    deletedBuckets: [],
    scheduledKeys: [],
    requestedDeletes: [],
    problems: [],
    ...overrides,
  };
}

function states(run: ReturnType<typeof startTeardownRun>) {
  return Object.fromEntries(
    teardownChecklist(run).map((item) => [item.id, item.state]),
  );
}

describe("a teardown run", () => {
  it("starts by waiting on both stacks, with the bucket held back", () => {
    const run = startTeardownRun(plan);
    expect(run.waitingFor).toEqual(["demo-bootstrap", "demo-state"]);
    expect(states(run)).toEqual({
      role: "active",
      "state-stack": "active",
      "bucket-demo-tfstate-123456789012-abcdef": "pending",
      "key-arn:aws:kms:eu-central-1:123456789012:key/k1": "pending",
    });
  });

  it("works on the bucket once its stack has gone", () => {
    const run = mergeTeardownProgress(
      startTeardownRun(plan),
      progress({ waitingFor: ["demo-bootstrap"] }),
    );
    const now = states(run);
    expect(now["state-stack"]).toBe("done");
    expect(now["bucket-demo-tfstate-123456789012-abcdef"]).toBe("active");
  });

  it("keeps what earlier rounds did, since each reports only its own work", () => {
    let run = startTeardownRun(plan);
    run = mergeTeardownProgress(
      run,
      progress({
        waitingFor: ["demo-bootstrap"],
        deletedBuckets: ["demo-tfstate-123456789012-abcdef"],
        scheduledKeys: [
          {
            arn: "arn:aws:kms:eu-central-1:123456789012:key/k1",
            deletionDate: "2026-11-24T00:00:00.000Z",
          },
        ],
      }),
    );
    run = mergeTeardownProgress(run, progress({ done: true }));

    expect(run.status).toBe("done");
    expect(run.deletedBuckets).toEqual(["demo-tfstate-123456789012-abcdef"]);
    expect(run.scheduledKeys).toHaveLength(1);
    expect(Object.values(states(run)).every((s) => s === "done")).toBe(true);
  });

  it("stops on a stack CloudFormation could not delete, and marks only that one", () => {
    const run = mergeTeardownProgress(
      startTeardownRun(plan),
      progress({
        waitingFor: ["demo-bootstrap", "demo-state"],
        problems: ["demo-state: The bucket policy could not be removed."],
      }),
    );

    expect(run.status).toBe("failed");
    const now = states(run);
    expect(now["state-stack"]).toBe("failed");
    expect(now.role).toBe("pending");
    // It never got to the bucket, so the bucket did not fail.
    expect(now["bucket-demo-tfstate-123456789012-abcdef"]).toBe("pending");

    const line = teardownChecklist(run).find((i) => i.id === "state-stack");
    expect(line?.detail).toContain("bucket policy");
  });

  it("marks the bucket failed when deleting it is what failed", () => {
    const run = failTeardownRun(
      mergeTeardownProgress(
        startTeardownRun(plan),
        progress({ waitingFor: [] }),
      ),
      "Could not delete the bucket: AccessDenied",
    );
    expect(states(run)["bucket-demo-tfstate-123456789012-abcdef"]).toBe(
      "failed",
    );
  });

  it("clears the failure on retry and keeps the progress", () => {
    const failed = failTeardownRun(
      mergeTeardownProgress(
        startTeardownRun(plan),
        progress({
          waitingFor: [],
          deletedBuckets: ["demo-tfstate-123456789012-abcdef"],
        }),
      ),
      "boom",
    );
    const retried = retryTeardownRun(failed);
    expect(retried.status).toBe("running");
    expect(retried.error).toBeNull();
    expect(retried.deletedBuckets).toEqual([
      "demo-tfstate-123456789012-abcdef",
    ]);
  });

  it("lists nothing for a setup that has nothing left in AWS", () => {
    const empty: TeardownPlan = {
      roleStack: null,
      stateStack: null,
      buckets: [],
      keyDeletionDays: 7,
    };
    expect(teardownChecklist(startTeardownRun(empty))).toEqual([]);
  });
});
