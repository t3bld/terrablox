"use client";

import { Button } from "@terrablox/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@terrablox/ui/dialog";
import { Input } from "@terrablox/ui/input";
import { Label } from "@terrablox/ui/label";
import { Skeleton } from "@terrablox/ui/skeleton";
import { AlertTriangle, Loader2, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { ChecklistItem } from "@/lib/projects/deploy-checklist";
import type { TeardownPlan } from "@/lib/projects/teardown";
import type { TeardownRun } from "@/lib/projects/teardown-run";

/** What the user types to confirm. A word rather than a name: it is read, not copied. */
const CONFIRM_WORD = "delete";

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/**
 * Asks before deleting the whole setup, and says exactly what that means.
 *
 * A dialog here, where the rest of the wizard confirms with a second press,
 * because this is the one action in it that cannot be undone: the state bucket
 * goes with every version in it. The plan is read from AWS when the dialog opens,
 * so the list is what is really there, including a bucket an earlier setup left
 * behind.
 */
export function TeardownDialog({
  projectId,
  open,
  onOpenChange,
  onConfirm,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (plan: TeardownPlan) => void;
}) {
  const [plan, setPlan] = useState<TeardownPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPlan(null);
    setError(null);
    setTyped("");

    fetch(`/api/projects/${projectId}/deploy/bootstrap?teardown=plan`)
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(
            typeof body?.error === "string"
              ? body.error
              : "Could not read what the setup consists of.",
          );
        }
        return body.plan as TeardownPlan;
      })
      .then((value) => {
        if (!cancelled) setPlan(value);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(
            e instanceof Error
              ? e.message
              : "Could not read what the setup consists of.",
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  const tracked = (plan?.buckets ?? []).reduce<number | null>(
    (sum, bucket) =>
      sum === null || bucket.trackedResources === null
        ? null
        : sum + bucket.trackedResources,
    0,
  );
  const unreadable = (plan?.buckets ?? []).some(
    (bucket) => bucket.trackedResources === null,
  );
  const empty =
    plan !== null &&
    !plan.roleStack &&
    !plan.stateStack &&
    plan.buckets.length === 0;

  const confirmed = typed.trim().toLowerCase() === CONFIRM_WORD;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Delete the deployment setup?</DialogTitle>
          <DialogDescription>
            Removes everything this setup created in AWS, so it can be built
            again from scratch. Afterwards the wizard starts again at the role.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-destructive text-sm">
            {error}
          </p>
        ) : plan === null ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : (
          <div className="space-y-4 text-sm">
            {empty ? (
              <p className="text-muted-foreground">
                Nothing of this setup is left in AWS. Confirming clears what the
                project still records, so the next setup starts clean.
              </p>
            ) : (
              <section className="space-y-1.5">
                <h5 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                  Deleted
                </h5>
                <ul className="space-y-1.5">
                  {plan.roleStack ? (
                    <PlanRow
                      name={plan.roleStack.name}
                      what="Deployment role and its GitHub trust"
                    />
                  ) : null}
                  {plan.stateStack ? (
                    <PlanRow
                      name={plan.stateStack.name}
                      what="State backend stack"
                    />
                  ) : null}
                  {plan.buckets.map((bucket) => (
                    <PlanRow
                      key={bucket.name}
                      name={bucket.name}
                      what={
                        bucket.orphaned
                          ? "State bucket left behind by an earlier setup, with every version"
                          : "State bucket, with every version"
                      }
                    />
                  ))}
                  {plan.buckets.some((bucket) => bucket.kmsKeyArn) ? (
                    <PlanRow
                      what={`Encryption key, scheduled for deletion in ${plan.keyDeletionDays} days. It can be restored until then.`}
                    />
                  ) : null}
                </ul>
              </section>
            )}

            <section className="space-y-1.5">
              <h5 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                Kept
              </h5>
              <ul className="space-y-1 text-muted-foreground text-xs">
                <li>
                  The account&apos;s GitHub identity provider. Every project in
                  the account shares it.
                </li>
                <li>
                  The workflow files and Actions variables in the repository.
                  The next setup overwrites them.
                </li>
              </ul>
            </section>

            {plan.buckets.length > 0 && (tracked !== 0 || unreadable) ? (
              <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <p>
                  {tracked !== null && tracked > 0 ? (
                    <>
                      The Terraform state still tracks{" "}
                      <span className="font-medium">
                        {plural(tracked, "resource")}
                      </span>
                      .{" "}
                    </>
                  ) : (
                    "The Terraform state could not be read, so it may still track resources. "
                  )}
                  They keep running in AWS, but Terraform loses track of them
                  for good. Run{" "}
                  <span className="font-medium">Terraform Destroy</span> in the
                  Deploy tab first if they should go too.
                </p>
              </div>
            ) : null}

            {empty ? null : (
              <div className="grid gap-2">
                <Label htmlFor="teardown-confirm">
                  Type <span className="font-mono">{CONFIRM_WORD}</span> to
                  confirm
                </Label>
                <Input
                  autoComplete="off"
                  id="teardown-confirm"
                  onChange={(event) => setTyped(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && confirmed) onConfirm(plan);
                  }}
                  value={typed}
                />
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} variant="outline">
            Cancel
          </Button>
          <Button
            disabled={plan === null || (!empty && !confirmed)}
            onClick={() => plan && onConfirm(plan)}
            variant="destructive"
          >
            <Trash2 className="mr-2 h-3.5 w-3.5" />
            Delete setup
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PlanRow({ what, name }: { what: string; name?: string }) {
  return (
    <li className="flex items-start gap-2">
      <Trash2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0">
        {what}
        {name ? (
          <span className="block break-all font-mono text-muted-foreground text-xs">
            {name}
          </span>
        ) : null}
      </span>
    </li>
  );
}

/** Shown in place of the step while a teardown runs, and once when it is done. */
export function TeardownStatus({
  run,
  items,
  onRetry,
  onDismiss,
  renderChecklist,
}: {
  run: TeardownRun;
  items: ChecklistItem[];
  onRetry: () => void;
  onDismiss: () => void;
  renderChecklist: (items: ChecklistItem[]) => React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <h4 className="flex items-center gap-2 font-semibold text-sm">
        {run.status === "running" ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
        ) : (
          <Trash2 className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        {run.status === "done"
          ? "The setup has been deleted"
          : run.status === "failed"
            ? "Deleting the setup stopped"
            : "Deleting the setup"}
      </h4>

      {items.length > 0 ? renderChecklist(items) : null}

      {run.problems.map((problem) => (
        <p className="text-muted-foreground text-xs" key={problem}>
          {problem}
        </p>
      ))}

      {run.status === "failed" ? (
        <div className="space-y-2">
          {run.error ? (
            <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-destructive text-xs">
              {run.error}
            </p>
          ) : null}
          <Button onClick={onRetry} size="sm" variant="outline">
            Try again
          </Button>
        </div>
      ) : null}

      {run.status === "done" ? (
        <div className="space-y-2">
          <p className="text-muted-foreground text-xs">
            Nothing of it is left in AWS except the shared GitHub identity
            provider. Create the role to start the setup again.
          </p>
          <Button onClick={onDismiss} size="sm">
            Set up again
          </Button>
        </div>
      ) : null}
    </div>
  );
}
