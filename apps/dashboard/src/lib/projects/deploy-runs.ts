import type { WorkflowRunDto } from "./types";

/**
 * Which runs may start while others are still going.
 *
 * Each workflow in the catalogue declares a `lock`. Two runs that share one
 * never overlap, because they would fight over the same thing: plan and apply
 * both take Terraform's state lock. A workflow without a lock runs alongside
 * anything. The same workflow never runs twice at once, lock or not, so a double
 * click cannot queue it twice.
 *
 * Runs are recognised by the `name:` their workflow is rendered with, so the
 * repository's other CI is never mistaken for one of these.
 *
 * Shared by the Deploy tab, which locks its buttons, and the run route, which
 * refuses a dispatch, so the two cannot disagree about what "busy" means.
 */
export interface RunnableWorkflow {
  id: string;
  name: string;
  lock: string | null;
}

/** A run that has been dispatched but that GitHub does not list yet. */
export interface PendingDispatch {
  name: string;
  /** When the dispatch was accepted, in milliseconds. */
  at: number;
}

/** What is in the way of starting a workflow: a listed run, or a pending one. */
export type RunBlocker =
  | { kind: "run"; run: WorkflowRunDto; workflow: RunnableWorkflow }
  | { kind: "pending"; workflow: RunnableWorkflow };

/** The runs of these workflows that are queued or in progress, newest first. */
export function activeRuns(
  runs: readonly WorkflowRunDto[],
  workflows: readonly RunnableWorkflow[],
): { run: WorkflowRunDto; workflow: RunnableWorkflow }[] {
  const byName = new Map(
    workflows.map((workflow) => [workflow.name, workflow]),
  );
  return runs.flatMap((run) => {
    const workflow = byName.get(run.name);
    return workflow && run.status !== "completed" ? [{ run, workflow }] : [];
  });
}

function conflicts(a: RunnableWorkflow, b: RunnableWorkflow): boolean {
  return a.id === b.id || (a.lock !== null && a.lock === b.lock);
}

/** Why `target` cannot start right now, or null when it can. */
export function blockerFor(
  target: RunnableWorkflow,
  input: {
    runs: readonly WorkflowRunDto[];
    workflows: readonly RunnableWorkflow[];
    pending?: readonly PendingDispatch[];
  },
): RunBlocker | null {
  const active = activeRuns(input.runs, input.workflows).find((entry) =>
    conflicts(target, entry.workflow),
  );
  if (active) return { kind: "run", ...active };

  for (const dispatch of input.pending ?? []) {
    const workflow = input.workflows.find(
      (entry) => entry.name === dispatch.name,
    );
    if (workflow && conflicts(target, workflow)) {
      return { kind: "pending", workflow };
    }
  }
  return null;
}

/**
 * Whether a run is the one a dispatch just started.
 *
 * GitHub accepts a dispatch without returning the run it creates, and lists it
 * a few seconds later. Matched by name and by being created after the click, with
 * a little slack for the clock difference between this machine and GitHub.
 */
export function isRunFromDispatch(
  run: WorkflowRunDto,
  dispatch: PendingDispatch,
): boolean {
  return (
    run.name === dispatch.name &&
    new Date(run.createdAt).getTime() >= dispatch.at - 30_000
  );
}
