"use client";

import { Skeleton } from "@terrablox/ui/skeleton";
import { AlertCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { ProjectDeployState } from "@/lib/projects/types";
import { DeployWizard, WIZARD_COLUMN } from "./deploy-wizard";

/**
 * The setup wizard on its own, for tabs that need it but are not the Deploy tab.
 *
 * The State tab used to show a "Connect AWS" card of its own, which was a second
 * front door to the same setup: it connected the account and then said nothing
 * about the state backend that tab is actually about. Showing the same wizard
 * means one path, wherever a user notices that the project is not set up yet.
 *
 * It reads the deploy state itself rather than taking it as a prop. `DeployPanel`
 * keeps its own copy because it also drives the run controls from it, and passing
 * one down from the page would make every tab wait for a request only two of them
 * use.
 */
export function DeploySetupWizard({
  projectId,
  onAttachAws,
}: {
  projectId: string;
  onAttachAws: (accountId: string) => Promise<void>;
}) {
  const [state, setState] = useState<ProjectDeployState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);

    try {
      const response = await fetch(`/api/projects/${projectId}/deploy`);
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error ?? "Failed to load");
      setState(body.deploy as ProjectDeployState);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <p className="flex items-center gap-2 p-6 text-sm text-destructive">
        <AlertCircle className="h-4 w-4 shrink-0" />
        {error}
      </p>
    );
  }

  if (!state) {
    return (
      <div className={WIZARD_COLUMN}>
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  return (
    <div className={WIZARD_COLUMN}>
      <DeployWizard
        onAttach={onAttachAws}
        onChanged={load}
        projectId={projectId}
        state={state}
      />
    </div>
  );
}
