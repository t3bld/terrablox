"use client";

import { Button } from "@terrablox/ui/button";
import {
  AlertCircle,
  Check,
  Copy,
  ExternalLink,
  KeyRound,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PreviousSignIn } from "@/lib/aws/project-connection";
import { readJson } from "@/lib/read-json";

interface LoginStart {
  loginId: string;
  userCode: string;
  verificationUri: string;
  intervalSeconds: number;
  expiresAt: string;
}

interface SsoAccount {
  accountId: string;
  name: string;
  roles: string[];
}

type Stage =
  | { name: "idle" }
  | { name: "starting" }
  | { name: "waiting"; login: LoginStart }
  | { name: "connecting" }
  | { name: "done" };

/**
 * Signing in again to the account and permission set a project already uses.
 *
 * The full sign-in asks for a portal, then an account, then a role. For a
 * finished setup all three are settled, so this asks for nothing: one click
 * starts the device sign-in, the user confirms the code in AWS, and the same
 * account and role are connected again without another question.
 *
 * If the sign-in no longer reaches that account or role, it says so and hands
 * over to the full form, rather than quietly connecting something else.
 */
export function AwsQuickReconnect({
  signIn,
  onConnected,
  onChooseOther,
}: {
  signIn: PreviousSignIn;
  onConnected: (accountId: string) => Promise<void>;
  /** Switch to the full sign-in, with every choice open again. */
  onChooseOther: () => void;
}) {
  const [stage, setStage] = useState<Stage>({ name: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const loginRef = useRef<string | null>(null);

  const complete = useCallback(
    async (login: LoginStart, accounts: SsoAccount[]) => {
      const account = accounts.find((a) => a.accountId === signIn.accountId);
      if (!account || !account.roles.includes(signIn.roleName)) {
        setStage({ name: "idle" });
        setError(
          account
            ? `This sign-in no longer has the permission set ${signIn.roleName} on ${signIn.accountName}.`
            : `This sign-in has no access to ${signIn.accountName} (${signIn.accountId}) any more.`,
        );
        return;
      }

      setStage({ name: "connecting" });
      try {
        const res = await fetch(`/api/aws/sso/${login.loginId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            accountId: signIn.accountId,
            roleName: signIn.roleName,
            label: account.name,
          }),
        });
        const body = await readJson<{
          connection?: { accountId: string | null };
          error?: string;
        }>(res);
        if (!res.ok || !body.connection) {
          throw new Error(body.error ?? "Could not connect the account.");
        }
        await onConnected(body.connection.accountId ?? signIn.accountId);
        setStage({ name: "done" });
      } catch (e) {
        setStage({ name: "idle" });
        setError(e instanceof Error ? e.message : "Could not connect.");
      }
    },
    [signIn, onConnected],
  );

  // Polls until the user confirmed the code in AWS, then connects at once.
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
          setError(body.error ?? "The sign-in failed.");
          setStage({ name: "idle" });
        } else if (body.state === "expired") {
          setError("The code expired before it was confirmed. Try again.");
          setStage({ name: "idle" });
        } else if (body.state === "ready" && body.accounts) {
          cancelled = true;
          clearInterval(timer);
          void complete(login, body.accounts);
        }
      } catch {
        // A dropped poll is retried on the next tick.
      }
    }, login.intervalSeconds * 1000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [stage, complete]);

  // An abandoned sign-in is cancelled server-side when the card goes away.
  useEffect(
    () => () => {
      const loginId = loginRef.current;
      if (loginId) {
        void fetch(`/api/aws/sso/${loginId}`, { method: "DELETE" }).catch(
          () => {},
        );
      }
    },
    [],
  );

  const start = async () => {
    setError(null);
    setStage({ name: "starting" });
    // Opened before the request so the browser treats it as the click's own
    // window rather than a popup, then pointed at the sign-in page.
    const tab = window.open("about:blank", "_blank");
    // Severed before it loads AWS, so that page cannot reach back into this one.
    if (tab) tab.opener = null;
    try {
      const res = await fetch("/api/aws/sso", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startUrl: signIn.startUrl,
          ...(signIn.ssoRegion ? { ssoRegion: signIn.ssoRegion } : {}),
        }),
      });
      const body = await readJson<{ login?: LoginStart; error?: string }>(res);
      if (!res.ok || !body.login) {
        throw new Error(body.error ?? "Could not start the sign-in.");
      }
      loginRef.current = body.login.loginId;
      if (tab) tab.location.href = body.login.verificationUri;
      setStage({ name: "waiting", login: body.login });
    } catch (e) {
      tab?.close();
      setStage({ name: "idle" });
      setError(e instanceof Error ? e.message : "Could not start the sign-in.");
    }
  };

  const cancel = () => {
    const loginId = loginRef.current;
    loginRef.current = null;
    setStage({ name: "idle" });
    if (loginId) {
      void fetch(`/api/aws/sso/${loginId}`, { method: "DELETE" }).catch(
        () => {},
      );
    }
  };

  const portalHost = (() => {
    try {
      return new URL(signIn.startUrl).host;
    } catch {
      return signIn.startUrl;
    }
  })();

  return (
    <div className="space-y-4">
      {/* What is about to be connected, so the one click is not a blind one. */}
      <dl className="grid gap-px overflow-hidden rounded-lg border bg-border text-sm sm:grid-cols-3">
        <Fact label="Account">
          <span className="block truncate font-medium">
            {signIn.accountName}
          </span>
          <span className="block font-mono text-muted-foreground text-xs">
            {signIn.accountId}
          </span>
        </Fact>
        <Fact label="Permission set">
          <span className="block truncate font-medium">{signIn.roleName}</span>
        </Fact>
        <Fact label="Portal">
          <span className="block truncate font-mono text-xs">{portalHost}</span>
        </Fact>
      </dl>

      {stage.name === "waiting" ? (
        <div className="space-y-4 rounded-xl border bg-muted/30 p-5 text-center">
          <p className="flex items-center justify-center gap-2 font-medium text-sm">
            <Loader2 className="h-4 w-4 animate-spin text-sky-500" />
            Confirm this code in the AWS tab
          </p>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(stage.login.userCode)
                .then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
            }}
            className="group mx-auto flex items-center gap-3 rounded-lg border bg-background px-5 py-3 shadow-sm transition-colors hover:border-foreground/30"
            title="Copy the code"
          >
            <span className="font-mono font-semibold text-2xl tracking-[0.3em]">
              {stage.login.userCode}
            </span>
            {copied ? (
              <Check className="h-4 w-4 text-emerald-600" />
            ) : (
              <Copy className="h-4 w-4 text-muted-foreground group-hover:text-foreground" />
            )}
          </button>
          <p className="text-muted-foreground text-xs">
            Connects automatically as soon as you approve it.
          </p>
          <div className="flex justify-center gap-2">
            <Button variant="outline" size="sm" asChild>
              <a
                href={stage.login.verificationUri}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink className="mr-2 h-3.5 w-3.5" />
                Open AWS again
              </a>
            </Button>
            <Button variant="ghost" size="sm" onClick={cancel}>
              Cancel
            </Button>
          </div>
        </div>
      ) : stage.name === "connecting" || stage.name === "done" ? (
        <p className="flex items-center gap-2 rounded-xl border bg-emerald-500/5 p-4 text-emerald-700 text-sm dark:text-emerald-400">
          {stage.name === "connecting" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ShieldCheck className="h-4 w-4" />
          )}
          {stage.name === "connecting"
            ? `Approved. Connecting ${signIn.accountName}…`
            : "Connected."}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            onClick={() => void start()}
            disabled={stage.name === "starting"}
            className="gap-2"
          >
            {stage.name === "starting" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <KeyRound className="h-4 w-4" />
            )}
            Connect
          </Button>
          <button
            type="button"
            onClick={onChooseOther}
            className="text-muted-foreground text-xs underline-offset-4 hover:text-foreground hover:underline"
          >
            Use a different account
          </button>
        </div>
      )}

      {error ? (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-destructive text-sm">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-1">
            <p>{error}</p>
            <button
              type="button"
              onClick={onChooseOther}
              className="text-xs underline underline-offset-4"
            >
              Choose the account and role yourself
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Fact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 bg-background px-3 py-2.5">
      <dt className="mb-0.5 text-[11px] text-muted-foreground uppercase tracking-wide">
        {label}
      </dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}
