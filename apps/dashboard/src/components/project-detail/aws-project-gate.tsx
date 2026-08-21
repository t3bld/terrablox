"use client";

import { Badge } from "@terrablox/ui/badge";
import { Button } from "@terrablox/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@terrablox/ui/card";
import { Skeleton } from "@terrablox/ui/skeleton";
import { AlertCircle, Clock, Cloud, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { AwsSsoConnect } from "@/components/account/aws-sso-connect";

/** Mirrors `ProjectAwsState` in `lib/aws/project-connection`. */
type ProjectAwsState =
  | { connected: false; reason: "none" }
  | {
      connected: boolean;
      reason: "unverified" | "expired" | "ok";
      accountId: string;
      region: string;
      label: string;
      credentialMode: string;
      expiresAt: string | null;
    };

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
 * What the Deploy and State tabs show until this project can reach AWS.
 *
 * The connect flow lives here rather than in account settings, because which AWS
 * account to deploy into is a fact about a project, not about a person. Someone
 * with two projects usually has two accounts, and a single account connected
 * "for the user" cannot answer which one this project means.
 *
 * Signing in and choosing are still two steps: the sign-in creates a connection
 * the user owns, and this tab then points the project at it.
 */
export function AwsProjectGate({
  projectId,
  blocked,
  explanation,
  children,
}: {
  projectId: string;
  /** What stays unavailable until the account is connected. */
  blocked: string[];
  explanation: string;
  children: React.ReactNode;
}) {
  const [state, setState] = useState<ProjectAwsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch(`/api/projects/${projectId}/aws`);
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(body?.error ?? "Could not read the AWS connection.");
    }
    return body.aws as ProjectAwsState;
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;

    load()
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Could not read AWS status.",
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [load]);

  const refresh = useCallback(() => {
    setError(null);
    load()
      .then(setState)
      .catch((err: unknown) => {
        setError(
          err instanceof Error ? err.message : "Could not read AWS status.",
        );
      });
  }, [load]);

  /** Points this project at the account that was just signed in to. */
  const attach = useCallback(
    async (accountId: string | null, region: string) => {
      if (!accountId) {
        setError("That sign-in did not report an account id.");
        return;
      }

      setBusy(true);
      setError(null);

      try {
        const response = await fetch(`/api/projects/${projectId}/aws`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accountId, region }),
        });
        const body = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(body?.error ?? "Could not attach that account.");
        }
        setState(body.aws as ProjectAwsState);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Could not attach that account.",
        );
      } finally {
        setBusy(false);
      }
    },
    [projectId],
  );

  if (!state) {
    return error ? (
      <p className="flex items-center gap-2 p-6 text-sm text-destructive">
        <AlertCircle className="h-4 w-4 shrink-0" />
        {error}
      </p>
    ) : (
      <Skeleton className="m-6 h-64" />
    );
  }

  if (state.connected) {
    const left = state.expiresAt ? remaining(state.expiresAt) : null;

    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {/* A thin line rather than a card: once the account is connected this is
            no longer the point of the tab, but a session that is about to run out
            is worth seeing before a deploy fails halfway. */}
        <div className="flex flex-wrap items-center gap-2 border-b bg-muted/20 px-4 py-1.5 text-xs text-muted-foreground">
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
          <Button
            className="ml-auto h-6 px-2 text-xs"
            onClick={refresh}
            size="sm"
            variant="ghost"
          >
            <RefreshCw className="h-3 w-3" />
            Recheck
          </Button>
        </div>

        <div className="min-h-0 flex-1">{children}</div>
      </div>
    );
  }

  const heading =
    state.reason === "expired"
      ? "The AWS sign-in for this project has expired"
      : state.reason === "unverified"
        ? "The AWS connection for this project is not verified yet"
        : "Connect an AWS account for this project";

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
              <Cloud className="h-4 w-4 text-muted-foreground" />
            </span>
            <div className="min-w-0">
              <CardTitle className="text-base">{heading}</CardTitle>
              <CardDescription>{explanation}</CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          <ul className="space-y-1 text-sm text-muted-foreground">
            {blocked.map((item) => (
              <li className="flex gap-2" key={item}>
                <span aria-hidden="true">·</span>
                {item}
              </li>
            ))}
          </ul>

          {state.reason !== "none" ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/20 p-2.5 text-xs">
              <span className="font-mono">{state.accountId}</span>
              <Badge variant="outline">{state.region}</Badge>
              {state.expiresAt ? (
                <span className="text-muted-foreground">
                  {remaining(state.expiresAt) ?? state.expiresAt}
                </span>
              ) : null}
              <Button
                className="ml-auto h-7 px-2 text-xs"
                onClick={refresh}
                size="sm"
                variant="ghost"
              >
                <RefreshCw className="h-3 w-3" />
                Recheck
              </Button>
            </div>
          ) : null}

          {error ? (
            <p className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </p>
          ) : null}
        </CardContent>
      </Card>

      {/* The sign-in itself. Signing in again is how an expired session is
          renewed, so the same flow covers both the first connection and every
          renewal after it. */}
      <AwsSsoConnect
        onConnected={(connection) => {
          void attach(connection.accountId, connection.region);
        }}
        usesSessionOnly
      />

      {busy ? (
        <p className="text-center text-xs text-muted-foreground">
          Attaching the account to this project…
        </p>
      ) : null}
    </div>
  );
}
