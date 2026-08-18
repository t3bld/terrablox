"use client";

import { Badge } from "@terrablox/ui/badge";
import { Button } from "@terrablox/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@terrablox/ui/card";
import { Check, ExternalLink, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { readJson } from "@/lib/read-json";

import { AwsSsoConnect } from "./aws-sso-connect";

interface ConnectionView {
  id: string;
  label: string;
  accountId: string | null;
  roleArn: string;
  region: string;
  verifiedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

interface ConnectionsState {
  connections: ConnectionView[];
  principalArn: string | null;
}

export function AwsAccountsCard() {
  const [state, setState] = useState<ConnectionsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/aws/connections");
        const body = await readJson<ConnectionsState & { error?: string }>(res);
        if (cancelled) return;
        if (!res.ok) {
          setError(body.error ?? "Failed to load AWS connections");
          return;
        }
        setState(body);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleVerify = async (id: string) => {
    setBusy(id);
    setError(null);

    try {
      const res = await fetch(`/api/aws/connections/${id}/verify`, {
        method: "POST",
      });
      const body = await readJson<{
        connection?: ConnectionView;
        error?: string;
      }>(res);

      if (!res.ok || !body.connection) {
        setError(body.error ?? "Verification failed");
        return;
      }

      const updated = body.connection;
      setState((prev) =>
        prev
          ? {
              ...prev,
              connections: prev.connections.map((c) =>
                c.id === updated.id ? updated : c,
              ),
            }
          : prev,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Verification failed");
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async (id: string) => {
    setBusy(id);

    try {
      const res = await fetch(`/api/aws/connections/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        setError("Failed to disconnect the account");
        return;
      }
      setState((prev) =>
        prev
          ? {
              ...prev,
              connections: prev.connections.filter((c) => c.id !== id),
            }
          : prev,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to disconnect");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-1.5">
            <CardTitle>AWS</CardTitle>
            <Button asChild className="h-7 w-7" size="icon" variant="ghost">
              <a
                aria-label="Open AWS website"
                href="https://aws.amazon.com/iam/identity-center/"
                rel="noreferrer"
                target="_blank"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </Button>
          </div>
          <Badge
            className={
              state?.connections.length
                ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950 dark:text-emerald-300 dark:hover:bg-emerald-950"
                : "text-muted-foreground"
            }
            variant={state?.connections.length ? "secondary" : "outline"}
          >
            {state?.connections.length ? "Connected" : "Unconnected"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading accounts…
          </div>
        ) : (
          <>
            {state?.connections.length ? (
              <ul className="space-y-3">
                {state.connections.map((connection) => (
                  <ConnectionRow
                    key={connection.id}
                    connection={connection}
                    busy={busy === connection.id}
                    onVerify={() => handleVerify(connection.id)}
                    onDelete={() => handleDelete(connection.id)}
                  />
                ))}
              </ul>
            ) : null}

            <div className="space-y-4">
              <AwsSsoConnect
                onConnected={(created) =>
                  setState((prev) =>
                    prev
                      ? { ...prev, connections: [...prev.connections, created] }
                      : { connections: [created], principalArn: null },
                  )
                }
              />

              {error ? (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-destructive text-sm">
                  {error}
                </div>
              ) : null}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ConnectionRow({
  connection,
  busy,
  onVerify,
  onDelete,
}: {
  connection: ConnectionView;
  busy: boolean;
  onVerify: () => void;
  onDelete: () => void;
}) {
  const verified = Boolean(connection.verifiedAt);

  return (
    <li className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-sm">
              {connection.label || connection.accountId || "AWS account"}
            </span>
            {verified ? (
              <Badge variant="secondary" className="gap-1">
                <Check className="h-3 w-3" />
                Connected
              </Badge>
            ) : (
              <Badge variant="outline">Not verified</Badge>
            )}
          </div>
          <p className="truncate font-mono text-muted-foreground text-xs">
            {connection.roleArn}
          </p>
          <p className="text-muted-foreground text-xs">
            {connection.accountId
              ? `Account ${connection.accountId} · ${connection.region}`
              : connection.region}
          </p>
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={onVerify}
            disabled={busy}
          >
            <RefreshCw
              className={`mr-2 h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`}
            />
            {verified ? "Re-check" : "Verify"}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Disconnect account"
            onClick={onDelete}
            disabled={busy}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {connection.lastError ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-destructive text-xs">
          {connection.lastError}
        </p>
      ) : null}
    </li>
  );
}
