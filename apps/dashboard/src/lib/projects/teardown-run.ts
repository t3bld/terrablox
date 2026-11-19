/**
 * A whole-setup deletion as the wizard follows it, across its repeated calls.
 *
 * Separate from the component for the same reason as `deploy-steps`: it is the
 * part with decisions in it, and each of them can be checked without a browser.
 * Type-only imports from the server module, so nothing server-side reaches the
 * client bundle.
 */

import type { ChecklistItem } from "./deploy-checklist";
import type { TeardownPlan, TeardownProgress } from "./teardown";

export interface TeardownRun {
  plan: TeardownPlan;
  status: "running" | "failed" | "done";
  /** Stacks CloudFormation is still deleting, as the last call reported. */
  waitingFor: string[];
  /**
   * Accumulated, because each call only reports what it did itself, and the
   * last one usually did nothing but clear the project's pointers.
   */
  deletedBuckets: string[];
  scheduledKeys: TeardownProgress["scheduledKeys"];
  /** What CloudFormation said about a stack it could not delete. */
  problems: string[];
  /** A request that failed outright, e.g. a bucket S3 would not delete. */
  error: string | null;
}

export function startTeardownRun(plan: TeardownPlan): TeardownRun {
  return {
    plan,
    status: "running",
    waitingFor: [plan.roleStack?.name, plan.stateStack?.name].filter(
      (name): name is string => Boolean(name),
    ),
    deletedBuckets: [],
    scheduledKeys: [],
    problems: [],
    error: null,
  };
}

export function mergeTeardownProgress(
  run: TeardownRun,
  progress: TeardownProgress,
): TeardownRun {
  const keys = new Map(run.scheduledKeys.map((key) => [key.arn, key]));
  for (const key of progress.scheduledKeys) keys.set(key.arn, key);

  return {
    ...run,
    // A stack CloudFormation could not delete stops the run rather than being
    // asked again every few seconds; the user retries once the cause is fixed.
    status: progress.done
      ? "done"
      : progress.problems.length > 0
        ? "failed"
        : "running",
    waitingFor: progress.waitingFor,
    deletedBuckets: [
      ...new Set([...run.deletedBuckets, ...progress.deletedBuckets]),
    ],
    scheduledKeys: [...keys.values()],
    problems: progress.problems,
    error: null,
  };
}

/** The run after a request failed outright. Everything done so far stays done. */
export function failTeardownRun(run: TeardownRun, error: string): TeardownRun {
  return { ...run, status: "failed", error };
}

/** The run after the user pressed "Try again". */
export function retryTeardownRun(run: TeardownRun): TeardownRun {
  return { ...run, status: "running", error: null, problems: [] };
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

/**
 * The teardown as a checklist, in the order it happens.
 *
 * The same lines before, during and after, so the reader sees what is going to
 * go and then watches it go. Lines for things the plan did not find are left
 * out rather than shown as done.
 *
 * Only the line that actually stopped is marked failed. Marking everything not
 * yet done as failed said the bucket had failed to delete when the run had never
 * got as far as trying.
 */
export function teardownChecklist(run: TeardownRun): ChecklistItem[] {
  const { plan } = run;
  const failed = run.status === "failed";
  const done = run.status === "done";
  const items: ChecklistItem[] = [];

  const stackLine = (
    id: string,
    label: string,
    stack: { name: string } | null,
  ) => {
    if (!stack) return;
    const pending = !done && run.waitingFor.includes(stack.name);
    const problem = run.problems.find((entry) =>
      entry.startsWith(`${stack.name}:`),
    );
    items.push({
      id,
      label,
      state: !pending
        ? "done"
        : problem || (failed && run.error)
          ? "failed"
          : failed
            ? "pending"
            : "active",
      detail: problem ?? stack.name,
    });
  };

  stackLine("role", "Delete the deployment role", plan.roleStack);
  stackLine("state-stack", "Delete the state backend stack", plan.stateStack);

  const stateStackPending =
    !done && plan.stateStack
      ? run.waitingFor.includes(plan.stateStack.name)
      : false;

  for (const bucket of plan.buckets) {
    const deleted = done || run.deletedBuckets.includes(bucket.name);
    items.push({
      id: `bucket-${bucket.name}`,
      label: "Delete the state bucket and every version in it",
      state: deleted
        ? "done"
        : stateStackPending
          ? "pending"
          : failed
            ? run.error
              ? "failed"
              : "pending"
            : "active",
      detail: stateStackPending
        ? `${bucket.name} — waits for the state stack to be gone.`
        : bucket.name,
    });
  }

  const keyArns = [
    ...new Set(
      plan.buckets
        .map((bucket) => bucket.kmsKeyArn)
        .filter((arn): arn is string => Boolean(arn)),
    ),
  ];
  for (const arn of keyArns) {
    const scheduled = run.scheduledKeys.find((key) => key.arn === arn);
    const date = formatDate(scheduled?.deletionDate ?? null);
    items.push({
      id: `key-${arn}`,
      label: "Schedule the encryption key for deletion",
      state: scheduled || done ? "done" : "pending",
      detail: scheduled
        ? `Deleted on ${date ?? "the date KMS reports"}. Until then it can be restored in the KMS console.`
        : arn,
    });
  }

  return items;
}
