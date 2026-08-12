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
import { Input } from "@terrablox/ui/input";
import { Label } from "@terrablox/ui/label";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  Copy,
  Download,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import { readJson } from "@/lib/read-json";

import { AwsSsoConnect } from "./aws-sso-connect";

interface ConnectionView {
  id: string;
  label: string;
  accountId: string | null;
  roleArn: string;
  region: string;
  externalId: string;
  verifiedAt: string | null;
  lastError: string | null;
  template: string;
  createdAt: string;
}

interface ConnectionsState {
  connections: ConnectionView[];
  principalArn: string | null;
}

const DEFAULT_REGION = "eu-central-1";

export function AwsAccountsCard() {
  const [state, setState] = useState<ConnectionsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [roleArn, setRoleArn] = useState("");
  const [region, setRegion] = useState(DEFAULT_REGION);

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

  const handleAdd = async (event: FormEvent) => {
    event.preventDefault();
    setAdding(true);
    setError(null);

    try {
      const res = await fetch("/api/aws/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, roleArn, region }),
      });
      const body = await readJson<{
        connection?: ConnectionView;
        error?: string;
      }>(res);

      if (!res.ok || !body.connection) {
        setError(body.error ?? "Failed to add the account");
        return;
      }

      const created = body.connection;
      setState((prev) =>
        prev
          ? { ...prev, connections: [...prev.connections, created] }
          : { connections: [created], principalArn: null },
      );
      setLabel("");
      setRoleArn("");
      setRegion(DEFAULT_REGION);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add the account");
    } finally {
      setAdding(false);
    }
  };

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
        <CardTitle className="flex items-center gap-2">
          <Cloud className="h-5 w-5" />
          AWS accounts
        </CardTitle>
        <CardDescription>
          Connect an account so TerraBlox can read what actually exists in it.
          No keys are stored: you create a role, TerraBlox borrows it for a few
          minutes at a time, and deleting the role revokes access instantly.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading accounts…
          </div>
        ) : (
          <>
            {state && !state.principalArn ? (
              <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <p className="text-muted-foreground">
                  This TerraBlox instance has no AWS credentials of its own, so
                  it cannot discover the principal a role must trust. Give the
                  app an AWS identity — a task role or access keys — and it
                  fills the trust policy in automatically.
                </p>
              </div>
            ) : null}

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
            ) : (
              <p className="text-muted-foreground text-sm">
                No account is connected yet.
              </p>
            )}

            <div className="space-y-4 border-t pt-6">
              <AwsSsoConnect
                onConnected={(created) =>
                  setState((prev) =>
                    prev
                      ? { ...prev, connections: [...prev.connections, created] }
                      : { connections: [created], principalArn: null },
                  )
                }
              />

              <Collapsible label="Connect a role manually instead">
                <form onSubmit={handleAdd} className="space-y-4 pt-2">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="awsLabel">Name</Label>
                      <Input
                        id="awsLabel"
                        value={label}
                        onChange={(e) => setLabel(e.target.value)}
                        placeholder="e.g. Production"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="awsRegion">Region</Label>
                      <Input
                        id="awsRegion"
                        value={region}
                        onChange={(e) => setRegion(e.target.value)}
                        placeholder={DEFAULT_REGION}
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="awsRoleArn">Role ARN</Label>
                    <Input
                      id="awsRoleArn"
                      value={roleArn}
                      onChange={(e) => setRoleArn(e.target.value)}
                      placeholder="arn:aws:iam::123456789012:role/terrablox-read"
                      className="font-mono text-sm"
                    />
                    <p className="text-muted-foreground text-xs">
                      Add the account first — the setup stack you need is shown
                      afterwards, because it contains a secret generated for
                      this connection.
                    </p>
                  </div>

                  <Button type="submit" disabled={adding || !roleArn.trim()}>
                    {adding ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Plus className="mr-2 h-4 w-4" />
                    )}
                    Add account
                  </Button>
                </form>
              </Collapsible>

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

      <Collapsible label={verified ? "Setup stack" : "Set up the AWS side"}>
        <p className="text-muted-foreground text-xs">
          Run this stack in the account, then paste the{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono">
            RoleArn
          </code>{" "}
          output above and verify. The external ID is what stops anyone else
          from having TerraBlox assume your role.
        </p>

        <div className="space-y-1">
          <p className="font-medium text-xs">External ID</p>
          <CodeBlock content={connection.externalId} label="external ID" />
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              downloadFile("terrablox-connection.yml", connection.template)
            }
          >
            <Download className="mr-2 h-3.5 w-3.5" />
            Download template
          </Button>
        </div>

        <CodeBlock
          content={connection.template}
          label="connection template"
          language="yaml"
        />
      </Collapsible>
    </li>
  );
}

function downloadFile(name: string, content: string) {
  const url = URL.createObjectURL(
    new Blob([content], { type: "text/yaml;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function Collapsible({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-lg border">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left font-medium text-sm"
      >
        {open ? (
          <ChevronDown className="h-4 w-4" />
        ) : (
          <ChevronRight className="h-4 w-4" />
        )}
        <span className="truncate">{label}</span>
      </button>
      {open ? <div className="space-y-3 border-t p-3">{children}</div> : null}
    </div>
  );
}

function CodeBlock({
  content,
  label,
  language,
}: {
  content: string;
  label: string;
  language?: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Copy ${label}`}
        className="absolute top-1 right-1 h-7 w-7"
        onClick={() => {
          void navigator.clipboard.writeText(content).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-emerald-600" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </Button>
      <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs">
        <code data-language={language}>{content}</code>
      </pre>
    </div>
  );
}
