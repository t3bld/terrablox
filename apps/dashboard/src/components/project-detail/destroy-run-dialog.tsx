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
import { AlertTriangle, Flame, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * Asks before starting a destroy, by having the project's name typed back.
 *
 * A dialog rather than the second click the apply uses: an apply that went
 * wrong is usually fixed by the next apply, while a destroy removes databases
 * and buckets with whatever was in them. The name is the same check the run
 * route and the MCP tool make, so all three ways in agree on what "confirmed"
 * means.
 */
export function DestroyRunDialog({
  open,
  onOpenChange,
  onConfirm,
  starting,
  projectName,
  awsAccountId,
  awsRegion,
  repo,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with what was typed; the server checks it again. */
  onConfirm: (confirm: string) => void;
  starting: boolean;
  projectName: string;
  awsAccountId: string | null;
  awsRegion: string;
  /** `owner/name@branch`, where the run will appear. */
  repo: string | null;
}) {
  const [typed, setTyped] = useState("");

  // Empty every time it opens, so a name typed for an abandoned attempt cannot
  // arm the button for the next one.
  useEffect(() => {
    if (open) setTyped("");
  }, [open]);

  const confirmed = typed === projectName;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Destroy the infrastructure?</DialogTitle>
          <DialogDescription>
            Runs <span className="font-mono">terraform destroy</span> for{" "}
            <span className="font-medium text-foreground">{projectName}</span>.
            Every resource the configuration manages is removed, including
            anything stored in it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <dl className="grid gap-1 text-xs sm:grid-cols-[7rem_1fr]">
            <dt className="text-muted-foreground">AWS account</dt>
            <dd className="font-mono">{awsAccountId ?? "—"}</dd>
            <dt className="text-muted-foreground">Region</dt>
            <dd className="font-mono">{awsRegion}</dd>
            {repo ? (
              <>
                <dt className="text-muted-foreground">Runs in</dt>
                <dd className="break-all font-mono">{repo}</dd>
              </>
            ) : null}
          </dl>

          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div className="space-y-1">
              <p>
                The run plans the destroy first and puts the list in the run
                summary, then removes exactly what it lists. It does not wait
                for anyone in between.
              </p>
              <p className="text-muted-foreground">
                The deployment setup stays: the role, the state bucket and the
                workflows. Run an apply to build everything again, or use{" "}
                <span className="font-medium text-foreground">
                  Delete setup
                </span>{" "}
                afterwards to remove the setup too.
              </p>
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="destroy-confirm">
              Type <span className="font-mono">{projectName}</span> to confirm
            </Label>
            <Input
              autoComplete="off"
              id="destroy-confirm"
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && confirmed && !starting) {
                  onConfirm(typed);
                }
              }}
              spellCheck={false}
              value={typed}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            disabled={starting}
            onClick={() => onOpenChange(false)}
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            disabled={!confirmed || starting}
            onClick={() => onConfirm(typed)}
            variant="destructive"
          >
            {starting ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Flame className="mr-2 h-3.5 w-3.5" />
            )}
            Destroy in {awsAccountId ?? "AWS"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
