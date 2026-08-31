"use client";

import { Badge } from "@terrablox/ui/badge";
import { Button } from "@terrablox/ui/button";
import { Input } from "@terrablox/ui/input";
import { Label } from "@terrablox/ui/label";
import {
  ArrowRight,
  Check,
  ExternalLink,
  Loader2,
  Search,
  X,
} from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import { AwsRegionPicker } from "@/components/aws-region-picker";
import { readJson } from "@/lib/read-json";

/**
 * Signing in with IAM Identity Center to set up an account in one go.
 *
 * The sign-in creates the read role and is dropped, unless this instance has no
 * AWS identity of its own — then the sign-in itself is the connection.
 * TerraBlox keeps no AWS session after setup.
 */

interface ConnectionView {
  id: string;
  label: string;
  accountId: string | null;
  roleArn: string;
  region: string;
  externalId: string;
  credentialMode: string;
  sessionExpiresAt: string | null;
  verifiedAt: string | null;
  lastError: string | null;
  template: string;
  createdAt: string;
}

interface SsoAccount {
  accountId: string;
  name: string;
  roles: string[];
}

interface LoginStart {
  loginId: string;
  userCode: string;
  verificationUri: string;
  intervalSeconds: number;
  expiresAt: string;
}

type Stage =
  | { name: "idle" }
  | { name: "waiting"; login: LoginStart }
  | { name: "choosing"; login: LoginStart; accounts: SsoAccount[] };

export function AwsSsoConnect({
  onConnected,
  usesSessionOnly = false,
}: {
  onConnected: (connection: ConnectionView) => void;
  /** True when the app has no AWS identity and will keep this sign-in instead. */
  usesSessionOnly?: boolean;
}) {
  const [stage, setStage] = useState<Stage>({ name: "idle" });
  const [startUrl, setStartUrl] = useState("");
  /**
   * Empty means "work it out". The server reads the region off the portal and
   * falls back to a default, so this is only ever filled in by a user whose
   * sign-in has already failed once.
   */
  const [ssoRegion, setSsoRegion] = useState("");
  const [showSsoRegion, setShowSsoRegion] = useState(false);
  const [selected, setSelected] = useState<string>("");
  // Which permission set to assume. A user often holds several per account and
  // the one they want (usually admin) is rarely the first AWS happens to list.
  const [selectedRole, setSelectedRole] = useState<string>("");
  // Free-text filter over the account list; a landing zone can list dozens.
  const [accountFilter, setAccountFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Poll only while the user is away approving; AWS dictates the interval and
  // answers SlowDown if we ignore it.
  useEffect(() => {
    if (stage.name !== "waiting") return;

    let cancelled = false;
    const { login } = stage;

    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/aws/sso/${login.loginId}`);
        const body = await readJson<{
          state?: string;
          accounts?: SsoAccount[];
          error?: string;
        }>(res);

        if (cancelled) return;

        if (!res.ok) {
          setError(body.error ?? "Sign-in failed");
          setStage({ name: "idle" });
          return;
        }

        if (body.state === "expired") {
          setError("The sign-in expired. Start again.");
          setStage({ name: "idle" });
          return;
        }

        if (body.state === "ready" && body.accounts) {
          setStage({ name: "choosing", login, accounts: body.accounts });
          const first = body.accounts[0];
          setSelected(first?.accountId ?? "");
          setSelectedRole(first?.roles[0] ?? "");
        }
      } catch {
        // A dropped poll is not a failed login; the next tick retries.
      }
    }, login.intervalSeconds * 1000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [stage]);

  const handleStart = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/aws/sso", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startUrl,
          ...(ssoRegion.trim() ? { ssoRegion: ssoRegion.trim() } : {}),
        }),
      });
      const body = await readJson<{ login?: LoginStart; error?: string }>(res);

      if (!res.ok || !body.login) {
        setError(body.error ?? "Could not start the sign-in");
        setShowSsoRegion(true);
        return;
      }

      setStage({ name: "waiting", login: body.login });
      window.open(body.login.verificationUri, "_blank", "noopener,noreferrer");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the sign-in");
      setShowSsoRegion(true);
    } finally {
      setBusy(false);
    }
  };

  const handleComplete = async () => {
    if (stage.name !== "choosing") return;

    const account = stage.accounts.find((a) => a.accountId === selected);
    if (!account) return;

    // Only ever send a role the account actually offers; fall back to the first
    // if the picked one somehow no longer applies.
    const roleName = account.roles.includes(selectedRole)
      ? selectedRole
      : account.roles[0];
    if (!roleName) return;

    setBusy(true);
    setError(null);

    try {
      const res = await fetch(`/api/aws/sso/${stage.login.loginId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: account.accountId,
          roleName,
          label: account.name,
        }),
      });
      const body = await readJson<{
        connection?: ConnectionView;
        error?: string;
      }>(res);

      if (!res.ok || !body.connection) {
        setError(body.error ?? "Could not connect that account");
        return;
      }

      onConnected(body.connection);
      setStage({ name: "idle" });
      setStartUrl("");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not connect that account",
      );
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = async () => {
    if (stage.name === "idle") return;
    const { loginId } = stage.login;
    setStage({ name: "idle" });
    await fetch(`/api/aws/sso/${loginId}`, { method: "DELETE" }).catch(
      () => {},
    );
  };

  return (
    <div className="space-y-4">
      {stage.name === "idle" ? (
        <form onSubmit={handleStart} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="ssoStartUrl">Identity Center portal</Label>
              <Input
                id="ssoStartUrl"
                value={startUrl}
                onChange={(e) => setStartUrl(e.target.value)}
                placeholder="https://your-org.awsapps.com/start"
                className="font-mono text-sm"
              />
            </div>
            {showSsoRegion ? (
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="ssoRegion">Identity Center region</Label>
                <AwsRegionPicker
                  className="w-full sm:max-w-sm"
                  onChange={setSsoRegion}
                  triggerId="ssoRegion"
                  value={ssoRegion}
                />
                <p className="text-muted-foreground text-xs">
                  The portal did not say which region it is in, and the default
                  was refused. Enter the region where IAM Identity Center is
                  enabled.
                </p>
              </div>
            ) : null}
          </div>

          <Button
            className="cursor-pointer disabled:cursor-not-allowed"
            type="submit"
            disabled={busy || !startUrl.trim()}
          >
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Sign in
          </Button>
        </form>
      ) : null}

      {stage.name === "waiting" ? (
        <div className="space-y-3 rounded-md border bg-muted/30 p-4">
          <div className="flex items-center gap-2 text-sm">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            Waiting for you to approve in AWS…
          </div>
          <p className="text-muted-foreground text-sm">
            Check that the code shown in the AWS tab matches:
          </p>
          <p className="font-mono text-lg tracking-widest">
            {stage.login.userCode}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" asChild>
              <a
                href={stage.login.verificationUri}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink className="mr-2 h-4 w-4" />
                Open AWS again
              </a>
            </Button>
            <Button variant="ghost" size="sm" onClick={handleCancel}>
              <X className="mr-2 h-4 w-4" />
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {stage.name === "choosing" ? (
        <div className="space-y-4 rounded-md border bg-muted/30 p-4">
          <div className="flex items-center gap-2 text-sm">
            <Check className="h-4 w-4 text-emerald-600" />
            Signed in. Pick the account and role to connect.
          </div>

          {stage.accounts.length ? (
            (() => {
              const query = accountFilter.trim().toLowerCase();
              const filtered = query
                ? stage.accounts.filter(
                    (a) =>
                      a.name.toLowerCase().includes(query) ||
                      a.accountId.includes(query),
                  )
                : stage.accounts;

              return (
                <div className="space-y-2">
                  <div className="relative rounded-md border border-input bg-background focus-within:border-primary">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={accountFilter}
                      onChange={(e) => setAccountFilter(e.target.value)}
                      placeholder="Search accounts by name or ID"
                      className="border-0 pl-9 focus-visible:ring-0 focus-visible:ring-offset-0"
                      aria-label="Search accounts"
                    />
                  </div>

                  {filtered.length ? (
                    <ul className="max-h-72 space-y-2 overflow-y-auto">
                      {filtered.map((account) => {
                        const isSelected = selected === account.accountId;

                        return (
                          <li key={account.accountId}>
                            <button
                              type="button"
                              onClick={() => {
                                setSelected(account.accountId);
                                setSelectedRole(account.roles[0] ?? "");
                              }}
                              disabled={!account.roles.length}
                              className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm transition-colors disabled:opacity-50 ${
                                isSelected
                                  ? "border-primary bg-primary/5"
                                  : "hover:bg-muted"
                              }`}
                            >
                              <span>
                                <span className="font-medium">
                                  {account.name}
                                </span>
                                <span className="ml-2 font-mono text-muted-foreground text-xs">
                                  {account.accountId}
                                </span>
                              </span>
                              {account.roles.length ? (
                                <Badge variant="secondary">
                                  {account.roles.length === 1
                                    ? account.roles[0]
                                    : `${account.roles.length} roles`}
                                </Badge>
                              ) : (
                                <Badge variant="outline">no role</Badge>
                              )}
                            </button>

                            {/* Roles live under their account so the choice
                                reads as "which role, in this one". */}
                            {isSelected && account.roles.length > 1 ? (
                              <div className="mt-2 space-y-1.5 pl-3">
                                <Label className="text-muted-foreground text-xs">
                                  Role to assume
                                </Label>
                                <div className="flex flex-wrap gap-2">
                                  {account.roles.map((role) => (
                                    <button
                                      key={role}
                                      type="button"
                                      onClick={() => setSelectedRole(role)}
                                      className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                                        selectedRole === role
                                          ? "border-primary bg-primary text-primary-foreground"
                                          : "hover:bg-muted"
                                      }`}
                                    >
                                      {role}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="text-muted-foreground text-sm">
                      No account matches “{accountFilter}”.
                    </p>
                  )}
                </div>
              );
            })()
          ) : (
            <p className="text-muted-foreground text-sm">
              This sign-in has access to no accounts.
            </p>
          )}

          {/* No region field: nothing is created here in session mode, and which
              region a project works in is decided once in its Deploy settings,
              where the copy can explain that moving it later means moving state.
              Only the stack mode has a side effect worth spelling out. */}
          {usesSessionOnly ? null : (
            <p className="text-muted-foreground text-xs">
              TerraBlox creates a CloudFormation stack called{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono">
                terrablox-read-access
              </code>{" "}
              holding one read-only role, then forgets this sign-in. Delete the
              stack to revoke access.
            </p>
          )}

          <div className="flex gap-2">
            <Button
              onClick={handleComplete}
              disabled={busy || !selected || !selectedRole}
            >
              {busy ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <ArrowRight className="mr-2 h-4 w-4" />
              )}
              Connect
            </Button>
            <Button variant="ghost" onClick={handleCancel}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-destructive text-sm">
          {error}
        </div>
      ) : null}
    </div>
  );
}
