"use client";

import { useAuth } from "@terrablox/auth/hooks";
import { Badge } from "@terrablox/ui/badge";
import { Button } from "@terrablox/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@terrablox/ui/card";
import { ExternalLink } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

/**
 * Only relevant in "user" mode. GitHub App user tokens do not use scopes at
 * all - they use the fine-grained permissions of the App installation.
 */
const REQUIRED_SCOPES = ["repo", "read:org"];

type GitAuthMode = "app" | "user" | "none";

type AuthConfig = {
  githubConfigured: boolean;
  gitAuthMode: GitAuthMode;
};

export function GithubAccountCard() {
  const { user, linkOAuth } = useAuth();
  const [isLinking, setIsLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // null while unknown, so the button never flashes the wrong state.
  const [config, setConfig] = useState<AuthConfig | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/auth-config")
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (cancelled) return;
        setConfig({
          githubConfigured: !!body?.providers?.github,
          gitAuthMode: (body?.gitAuthMode as GitAuthMode) ?? "none",
        });
      })
      .catch(() => {
        // Assume available and let the link attempt surface the real error.
        if (!cancelled) {
          setConfig({ githubConfigured: true, gitAuthMode: "user" });
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const github = useMemo(() => {
    const identity = user?.identities?.find((id) => id.provider === "github");
    return {
      linked: !!identity,
      scopes: identity?.scopes ?? [],
    };
  }, [user]);

  const isAppMode = config?.gitAuthMode === "app";

  const missingScopes = useMemo(() => {
    if (!github.linked || isAppMode) return [];
    return REQUIRED_SCOPES.filter((scope) => !github.scopes.includes(scope));
  }, [github, isAppMode]);

  async function handleLink() {
    setError(null);
    setIsLinking(true);
    try {
      await linkOAuth("github", {
        redirectTo: window.location.href,
        // A GitHub App ignores scopes; sending them would be misleading.
        scopes: isAppMode ? undefined : REQUIRED_SCOPES,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to link account");
      setIsLinking(false);
    }
    // On success the browser leaves for GitHub, so the state is not reset here.
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-1.5">
            <CardTitle>GitHub</CardTitle>
            <Button asChild className="h-7 w-7" size="icon" variant="ghost">
              <a
                aria-label="Open GitHub website"
                href="https://github.com"
                rel="noreferrer"
                target="_blank"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </Button>
          </div>
          <Badge
            className={
              github.linked
                ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950 dark:text-emerald-300 dark:hover:bg-emerald-950"
                : "text-muted-foreground"
            }
            variant={github.linked ? "secondary" : "outline"}
          >
            {github.linked ? "Connected" : "Unconnected"}
          </Badge>
        </div>
        {!github.linked ? (
          <CardDescription>
            {isAppMode
              ? "Link your GitHub identity. Repositories are read through the GitHub App installation, so every member sees the same modules."
              : "Connect your GitHub account to import private and organization modules."}
          </CardDescription>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {config && !config.githubConfigured ? (
          <div className="space-y-1 rounded-md border border-dashed p-3 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">
              GitHub sign-in is not configured on this server.
            </p>
            <p>
              Register a GitHub App with the callback URL{" "}
              <code className="font-mono">/api/auth/callback/github</code>, then
              set <code className="font-mono">GITHUB_CLIENT_ID</code> and{" "}
              <code className="font-mono">GITHUB_CLIENT_SECRET</code> in{" "}
              <code className="font-mono">apps/dashboard/.env</code> and restart
              the dev server.
            </p>
          </div>
        ) : null}

        {missingScopes.length > 0 ? (
          <p className="text-xs text-amber-600 dark:text-amber-500">
            Missing scopes: {missingScopes.join(", ")}. Re-link the account to
            grant them.
          </p>
        ) : null}

        {github.linked ? (
          <div className="space-y-1.5">
            <p className="text-xs font-medium">
              {isAppMode ? "Access" : "Granted scopes"}
            </p>
            {isAppMode ? (
              <p className="text-xs text-muted-foreground">
                Granted by the GitHub App installation, not by scopes. Change
                which repositories it can reach in the installation settings.
              </p>
            ) : (
              <div className="flex flex-wrap gap-1">
                {github.scopes.length > 0 ? (
                  github.scopes.map((scope) => (
                    <Badge className="font-mono" key={scope} variant="outline">
                      {scope}
                    </Badge>
                  ))
                ) : (
                  <p className="text-xs text-muted-foreground">
                    GitHub reported none. Re-link to refresh.
                  </p>
                )}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              The agent commits with this token, so it can write wherever you
              can.
            </p>
          </div>
        ) : null}

        <div className="flex flex-col gap-2">
          {!github.linked ? (
            <Button
              className="w-full"
              onClick={handleLink}
              disabled={isLinking || !config?.githubConfigured}
            >
              {isLinking ? "Linking..." : "Link GitHub account"}
            </Button>
          ) : (
            <Button className="w-full" variant="outline" asChild>
              <a
                href="https://github.com/settings/applications"
                target="_blank"
                rel="noopener noreferrer"
              >
                Manage Organization Access
              </a>
            </Button>
          )}
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
