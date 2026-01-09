"use client";

import { useMemo } from "react";

import { Button } from "@terrablox/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@terrablox/ui/dialog";

type GithubAccessDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function GithubAccessDialog({
  open,
  onOpenChange,
}: GithubAccessDialogProps) {
  // These are the ONLY two pages where GitHub lets a user/org-admin grant access.
  // We can’t do this via API from the dashboard.
  const orgAccessUrl = useMemo(
    () => "https://github.com/settings/connections/applications",
    [],
  );

  const oauthAppsUrl = useMemo(
    () => "https://github.com/settings/applications",
    [],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>GitHub organization access</DialogTitle>
          <DialogDescription>
            To list organization repositories, GitHub requires you (and sometimes
            your org admin) to grant the OAuth app access. This must be done in
            GitHub’s UI.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div>
            <div className="font-medium">1) Grant / request access</div>
            <div className="text-muted-foreground">
              Open GitHub → “Organization access” and approve Terrablox for the
              orgs you want.
            </div>
            <Button asChild className="mt-2" variant="secondary">
              <a
                href={orgAccessUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open “Organization access”
              </a>
            </Button>
          </div>

          <div>
            <div className="font-medium">2) If repos are still missing</div>
            <div className="text-muted-foreground">
              Make sure your org allows third-party OAuth apps (some orgs require
              explicit admin approval).
            </div>
            <Button asChild className="mt-2" variant="outline">
              <a
                href={oauthAppsUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open GitHub OAuth Apps settings
              </a>
            </Button>
          </div>

          <div className="rounded-md border p-3 text-muted-foreground">
            Required scopes for listing org repos:
            <ul className="list-disc pl-5">
              <li>
                <code>read:org</code> (to read org membership / governance)
              </li>
              <li>
                <code>repo</code> (to read private repos; public repos don’t
                require it)
              </li>
            </ul>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

