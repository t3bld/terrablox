"use client";

import { useAuth } from "@terrablox/auth/hooks";
import { Button } from "@terrablox/ui/button";
import { AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * Tells the user that GitHub is gone, everywhere.
 *
 * Nothing in TerraBlox works without it: a project *is* a repository, the module
 * library is read from GitHub, and a turn runs on the user's Copilot seat. When
 * the grant is revoked every screen keeps its layout and fails one request at a
 * time — a project that will not open, a library that stays empty, an agent that
 * answers with an error. Each of those reads as a separate bug.
 *
 * So the cause is stated once, above all of them, with the way out. Checked
 * server-side rather than from the linked-account row, because revoking access on
 * GitHub leaves that row exactly as it was.
 */
export function GithubConnectionBanner() {
  const { linkOAuth } = useAuth();
  const [disconnected, setDisconnected] = useState(false);
  const [linking, setLinking] = useState(false);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/integrations/status")
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (cancelled || !body?.github) return;
        // Only when GitHub exists on this server but this user has no working
        // token. An unconfigured server is an operator's problem, and a banner
        // urging the user to reconnect would be advice they cannot act on.
        setDisconnected(
          body.github.configured === true && body.github.connected === false,
        );
      })
      .catch(() => {
        // An unknown answer is not a disconnection: the banner stays hidden
        // rather than accusing a working setup of being broken.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (!disconnected) return null;

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm"
      role="alert"
    >
      <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
      <p className="min-w-0 flex-1">
        <span className="font-medium">GitHub is not connected.</span>{" "}
        <span className="text-muted-foreground">
          Projects, modules and the agent all read from your GitHub account, so
          they cannot work until it is linked again.
        </span>
      </p>
      <Button
        className="shrink-0"
        disabled={linking}
        onClick={async () => {
          setLinking(true);
          try {
            await linkOAuth("github", { redirectTo: window.location.href });
          } catch {
            // The button returns to its normal state; the account screen has the
            // full flow with an error message if this keeps failing.
            setLinking(false);
          }
        }}
        size="sm"
      >
        {linking ? "Connecting…" : "Reconnect GitHub"}
      </Button>
    </div>
  );
}
