"use client";

import { Button } from "@terrablox/ui/button";
import { Clock, Cloud, Loader2, Unplug } from "lucide-react";
import { useState } from "react";

import type { ProjectAwsState } from "@/lib/aws/project-connection";

/** How long a sign-in has left, in the roughest useful unit. */
function remaining(expiresAt: string): string | null {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (Number.isNaN(ms)) return null;
  if (ms <= 0) return "expired";

  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min left`;

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h left` : `${hours} h ${rest} min left`;
}

/**
 * Which AWS account the project is working against, on every tab.
 *
 * It used to live inside the Deploy and State tabs, which is where it is set up
 * but not where it matters: a module dropped on the canvas is destined for an
 * account, and the session it would be deployed with can run out while somebody
 * is drawing. Nothing is shown until an account is connected — an empty bar on
 * the Code tab would be chrome that says nothing.
 */
export function AwsProjectStrip({
  projectId,
  state,
  onChanged,
}: {
  projectId: string;
  state: ProjectAwsState | null;
  onChanged: (next: ProjectAwsState) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!state?.connected) return null;

  const left = state.expiresAt ? remaining(state.expiresAt) : null;

  /** Unlinks the account. The sign-in itself, and the region, are left alone. */
  const disconnect = () => {
    setBusy(true);
    setError(null);

    fetch(`/api/projects/${projectId}/aws`, { method: "DELETE" })
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(body?.error ?? "Could not disconnect the account.");
        }
        onChanged(body.aws as ProjectAwsState);
      })
      .catch((err: unknown) => {
        setError(
          err instanceof Error ? err.message : "Could not disconnect it.",
        );
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted/20 px-4 py-1.5 text-xs text-muted-foreground">
      <Cloud className="h-3.5 w-3.5 shrink-0" />
      <span className="font-mono">{state.accountId}</span>
      <span>·</span>
      <span>{state.region}</span>
      {left ? (
        <>
          <span>·</span>
          <span className="flex items-center gap-1">
            <Clock className="h-3.5 w-3.5" />
            {left}
          </span>
        </>
      ) : null}

      {error ? <span className="text-destructive">{error}</span> : null}

      {/* Disconnect rather than a recheck: the strip is re-read on every load and
          after every change, so "look again" had nothing to add. Unlinking the
          account is the thing that could not be done anywhere. */}
      <Button
        className="ml-auto h-6 px-2 text-xs"
        disabled={busy}
        onClick={disconnect}
        size="sm"
        variant="ghost"
      >
        {busy ? (
          <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
        ) : (
          <Unplug className="mr-1.5 h-3 w-3" />
        )}
        Disconnect
      </Button>
    </div>
  );
}
